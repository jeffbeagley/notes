import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaClient, UserRole } from '@prisma/client';
import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { clearSession, currentUser, issueSession, publicUser } from './auth.js';
import { registerMediaRoutes } from './media.js';
import { registerJournalRoutes } from './journal.js';
import { registerNoteRoutes } from './notes.js';
import { registerLibraryRoutes } from './library.js';
import { registerOidcRoutes } from './oidc.js';
import { registerLlmRoutes } from './llm.js';
import { registerBriefingRoutes } from './briefing.js';
import { registerSearchRoutes } from './search.js';
import { registerSummaryRoutes } from './summary.js';
import { redisConnection } from './queue.js';

/// Routes reachable without a session. Everything else under /api/v1 is rejected by the auth hook,
/// so a new route is private by default.
const publicApiPaths = new Set([
  '/api/v1/health',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
  '/api/v1/auth/providers',
  '/api/v1/auth/oidc/start',
  '/api/v1/auth/oidc/callback',
]);

/// Authenticated, but exempt from the forced-password-change block so the user can escape it.
const passwordChangeExemptPaths = new Set(['/api/v1/auth/me', '/api/v1/auth/change-password']);

// Verified against when the username is unknown so login timing does not reveal account existence.
let dummyPasswordHash: Promise<string> | null = null;
function decoyHash() {
  dummyPasswordHash ??= argon2.hash(randomBytes(32).toString('hex'));
  return dummyPasswordHash;
}

export async function createApp(prisma = new PrismaClient()) {
  const isProduction = process.env.NODE_ENV === 'production';
  const docsEnabled = process.env.ENABLE_API_DOCS === 'true';

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.apiKey',
        ],
        censor: '[redacted]',
      },
    },
    // Fastify cannot see the real client IP or scheme behind an ingress/reverse proxy otherwise,
    // which breaks both rate limiting and OIDC redirect derivation.
    trustProxy: process.env.TRUST_PROXY !== 'false',
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES) || 2 * 1024 * 1024,
  });

  app.decorateRequest('authUser', undefined);

  // These must finish loading before any route is declared: @fastify/rate-limit attaches itself
  // through an onRoute hook, which never sees routes registered ahead of it.
  await app.register(cookie);
  await app.register(helmet, {
    // The API only serves JSON and user-uploaded images; a restrictive CSP here would not apply to
    // the separately served SPA, so lock the API's own responses down hard instead.
    contentSecurityPolicy: { directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX) || 600,
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  if (docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Notes & Daily Journal API',
          description: 'Self-hosted notes, daily journal, tasks, search, and LLM services API',
          version: process.env.APP_VERSION ?? '0.0.0-dev',
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/api/v1/openapi.json', async () => app.swagger());
  }

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'internal server error' });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/health', async () => ({ ok: true }));

  // Readiness gates traffic on the dependencies a request actually needs.
  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = { database: 'ok', redis: 'ok' };
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.database = 'error';
    }
    try {
      await redisConnection.ping();
    } catch {
      checks.redis = 'error';
    }
    const ok = checks.database === 'ok' && checks.redis === 'ok';
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const username = request.body?.username?.trim();
      const password = request.body?.password;
      if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });

      const user = await prisma.user.findUnique({ where: { username } });
      const passwordValid = await argon2.verify(user?.passwordHash ?? (await decoyHash()), password).catch(() => false);
      if (!user || !user.enabled || !passwordValid) {
        request.log.warn({ username }, 'failed login attempt');
        return reply.code(401).send({ error: 'invalid credentials' });
      }

      await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
      issueSession(reply, user.id);
      return { user: publicUser(user) };
    }
  );

  app.post('/api/v1/auth/logout', async (_request, reply) => {
    clearSession(reply);
    return reply.code(204).send();
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (publicApiPaths.has(path)) return;

    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.forcePasswordChange && !passwordChangeExemptPaths.has(path)) {
      return reply.code(403).send({ error: 'password change required' });
    }
  });

  app.get('/api/v1/auth/me', async (request, reply) => {
    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    return { user: publicUser(user) };
  });

  app.get('/api/v1/settings/user', async (request, reply) => {
    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    return { settings: { username: user.username, displayName: user.displayName, email: user.email, role: user.role, timezone: user.timezone, assistantPrompt: user.assistantPrompt, briefingPrompt: user.briefingPrompt } };
  });

  app.patch<{ Body: { timezone?: string; email?: string | null; displayName?: string | null; assistantPrompt?: string | null; briefingPrompt?: string | null } }>('/api/v1/settings/user', async (request, reply) => {
    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const timezone = request.body.timezone?.trim();
    if (!timezone) return reply.code(400).send({ error: 'timezone is required' });
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return reply.code(400).send({ error: 'timezone must be a valid IANA timezone' });
    }
    const email = request.body.email?.trim().toLowerCase() || null;
    const displayName = request.body.displayName?.trim() || null;
    const assistantPrompt = request.body.assistantPrompt?.trim() || null;
    const briefingPrompt = request.body.briefingPrompt?.trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'email must be valid' });
    if (displayName && displayName.length > 80) return reply.code(400).send({ error: 'display name must be 80 characters or fewer' });
    if (assistantPrompt && assistantPrompt.length > 4000) return reply.code(400).send({ error: 'assistant instructions must be 4,000 characters or fewer' });
    if (briefingPrompt && briefingPrompt.length > 4000) return reply.code(400).send({ error: 'briefing instructions must be 4,000 characters or fewer' });
    const existing = email ? await prisma.user.findUnique({ where: { email } }) : null;
    if (existing && existing.id !== user.id) return reply.code(409).send({ error: 'email is already in use' });
    const updated = await prisma.user.update({ where: { id: user.id }, data: { timezone, email, displayName, assistantPrompt, briefingPrompt } });
    return { settings: { username: updated.username, displayName: updated.displayName, email: updated.email, role: updated.role, timezone: updated.timezone, assistantPrompt: updated.assistantPrompt, briefingPrompt: updated.briefingPrompt } };
  });

  app.get('/api/v1/settings/platform', async (request, reply) => {
    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin privilege required' });
    return {
      platform: {
        runtime: isProduction ? 'production' : 'development',
        authentication: { passwordEnabled: true, oidcConfigured: Boolean(process.env.OIDC_ISSUER_URL && process.env.OIDC_CLIENT_ID), sessionSecretConfigured: Boolean(process.env.SESSION_SECRET) },
        integrations: { aiEnabled: process.env.LLM_ENABLED === 'true', aiCredentialConfigured: Boolean(process.env.LLM_API_KEY), queueConfigured: Boolean(process.env.REDIS_URL) },
        storage: { mediaStorageConfigured: Boolean(process.env.MEDIA_ROOT) },
        apiDocsEnabled: docsEnabled,
      },
    };
  });

  app.get('/api/v1/admin/users', async (request, reply) => {
    const user = await currentUser(request, prisma);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'admin privilege required' });
    return { users: await prisma.user.findMany({ select: { id: true, username: true, email: true, role: true, enabled: true, timezone: true, createdAt: true }, orderBy: { username: 'asc' } }) };
  });

  app.post<{ Body: { username?: string; email?: string; password?: string; role?: UserRole } }>('/api/v1/admin/users', async (request, reply) => {
    const admin = await currentUser(request, prisma);
    if (!admin) return reply.code(401).send({ error: 'authentication required' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'admin privilege required' });
    const username = request.body.username?.trim();
    const email = request.body.email?.trim().toLowerCase() || null;
    const password = request.body.password;
    const role = request.body.role ?? UserRole.user;
    if (!username || !/^[a-zA-Z0-9_-]{3,48}$/.test(username)) return reply.code(400).send({ error: 'username must use 3-48 letters, numbers, underscores, or hyphens' });
    if (!password || password.length < 12 || password.length > 200) return reply.code(400).send({ error: 'password must be 12-200 characters' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: 'email must be valid' });
    if (!Object.values(UserRole).includes(role)) return reply.code(400).send({ error: 'role must be admin or user' });
    try {
      const created = await prisma.user.create({ data: { username, email, passwordHash: await argon2.hash(password), role } });
      return reply.code(201).send({ user: { id: created.id, username: created.username, email: created.email, role: created.role, enabled: created.enabled, timezone: created.timezone, createdAt: created.createdAt } });
    } catch {
      return reply.code(409).send({ error: 'username or email is already in use' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { role?: UserRole } }>('/api/v1/admin/users/:id', async (request, reply) => {
    const admin = await currentUser(request, prisma);
    if (!admin) return reply.code(401).send({ error: 'authentication required' });
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'admin privilege required' });
    if (!request.body.role || !Object.values(UserRole).includes(request.body.role)) return reply.code(400).send({ error: 'role must be admin or user' });
    if (request.params.id === admin.id && request.body.role !== UserRole.admin) return reply.code(400).send({ error: 'you cannot remove your own admin role' });
    const target = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!target) return reply.code(404).send({ error: 'user not found' });
    const updated = await prisma.user.update({ where: { id: target.id }, data: { role: request.body.role } });
    return { user: { id: updated.id, username: updated.username, email: updated.email, role: updated.role, enabled: updated.enabled, timezone: updated.timezone, createdAt: updated.createdAt } };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/v1/auth/change-password',
    { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const user = await currentUser(request, prisma);
      if (!user) return reply.code(401).send({ error: 'authentication required' });
      const { currentPassword, newPassword } = request.body ?? {};
      if (!currentPassword || !newPassword || newPassword.length < 12 || newPassword.length > 200) {
        return reply.code(400).send({ error: 'current password and a new password of 12-200 characters are required' });
      }
      if (!(await argon2.verify(user.passwordHash, currentPassword))) return reply.code(401).send({ error: 'invalid credentials' });

      // Revokes every session issued before now, then re-issues one for this device.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await argon2.hash(newPassword),
          forcePasswordChange: false,
          sessionsValidFrom: new Date(),
          lastActiveAt: new Date(),
        },
      });
      issueSession(reply, user.id);
      return reply.code(204).send();
    }
  );

  registerNoteRoutes(app, prisma);
  registerLibraryRoutes(app, prisma);
  registerMediaRoutes(app, prisma);
  registerJournalRoutes(app, prisma);
  registerOidcRoutes(app, prisma);
  registerLlmRoutes(app, prisma);
  registerBriefingRoutes(app, prisma);
  registerSearchRoutes(app, prisma);
  registerSummaryRoutes(app, prisma);

  return app;
}