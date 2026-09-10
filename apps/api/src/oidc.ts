import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import * as oidc from 'openid-client';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { clearSession, issueSession, issueTransientCookie, readTransientCookie } from './auth.js';

const stateCookie = 'notes_oidc';
let configuration: oidc.Configuration | undefined;

function settings() {
  const issuer = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return null;
  return { issuer, clientId, clientSecret: process.env.OIDC_CLIENT_SECRET, scopes: process.env.OIDC_SCOPES ?? 'openid profile email' };
}

export function isOidcEnabled() {
  return Boolean(settings());
}

function redirectUri(request: { protocol: string; hostname: string }) {
  // Deriving this from Host/X-Forwarded-Proto is attacker-influenced, so production must pin it.
  const configured = process.env.OIDC_REDIRECT_URI;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_REDIRECT_URI must be set when OIDC is enabled in production');
  }
  return `${request.protocol}://${request.hostname}/api/v1/auth/oidc/callback`;
}

const discoveryTtlMs = 60 * 60 * 1000;
let configurationFetchedAt = 0;

async function clientConfiguration() {
  const config = settings();
  if (!config) throw new Error('OIDC is not configured');
  // Re-discover periodically so IdP key rotation does not require a restart.
  if (!configuration || Date.now() - configurationFetchedAt > discoveryTtlMs) {
    configuration = await oidc.discovery(new URL(config.issuer), config.clientId, undefined, config.clientSecret ? oidc.ClientSecretBasic(config.clientSecret) : undefined);
    configurationFetchedAt = Date.now();
  }
  return configuration;
}

function usernameFor(email: string | undefined, subject: string) {
  return (email?.split('@')[0] ?? `oidc-${subject.slice(0, 12)}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48) || 'oidc-user';
}

export function registerOidcRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get('/api/v1/auth/providers', async () => ({ oidc: isOidcEnabled() }));

  app.get('/api/v1/auth/oidc/start', async (request, reply) => {
    const config = settings();
    if (!config) return reply.code(503).send({ error: 'OIDC is not configured' });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = randomUUID();
    issueTransientCookie(reply, stateCookie, JSON.stringify({ verifier, state }));
    const authorizationUrl = oidc.buildAuthorizationUrl(await clientConfiguration(), { redirect_uri: redirectUri(request), scope: config.scopes, response_type: 'code', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state });
    return reply.redirect(authorizationUrl.href);
  });

  app.get<{ Querystring: { state?: string } }>('/api/v1/auth/oidc/callback', async (request, reply) => {
    const transient = readTransientCookie(request, stateCookie);
    clearSession(reply);
    reply.clearCookie(stateCookie, { path: '/' });
    if (!transient) return reply.code(400).send({ error: 'OIDC sign-in state expired' });
    const { verifier, state } = JSON.parse(transient) as { verifier: string; state: string };
    if (!request.query.state || request.query.state !== state) return reply.code(400).send({ error: 'OIDC sign-in state mismatch' });
    try {
      const tokens = await oidc.authorizationCodeGrant(await clientConfiguration(), new URL(request.raw.url ?? '', redirectUri(request)), { pkceCodeVerifier: verifier, expectedState: state });
      const claims = tokens.claims();
      if (!claims) return reply.code(400).send({ error: 'OIDC response has no ID token claims' });
      const subject = claims.sub;
      if (!subject) return reply.code(400).send({ error: 'OIDC response has no subject claim' });
      const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
      const emailVerified = claims.email_verified === true;
      const adminAllowlist = new Set((process.env.OIDC_ADMIN_EMAILS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
      let user = await prisma.user.findUnique({ where: { oidcSubject: subject } });
      if (!user && email) {
        const matchingEmailUser = await prisma.user.findUnique({ where: { email } });
        if (matchingEmailUser && !emailVerified) return reply.code(403).send({ error: 'OIDC provider must verify the matching email address' });
        if (matchingEmailUser?.oidcSubject && matchingEmailUser.oidcSubject !== subject) return reply.code(409).send({ error: 'email is already linked to another OIDC account' });
        if (matchingEmailUser) user = await prisma.user.update({ where: { id: matchingEmailUser.id }, data: { oidcSubject: subject } });
      }
      if (!user) {
        const username = usernameFor(email, subject);
        user = await prisma.user.create({ data: { username: await uniqueUsername(prisma, username), passwordHash: await argon2.hash(randomUUID()), oidcSubject: subject, email, role: email && adminAllowlist.has(email) ? 'admin' : 'user' } });
      }
      if (!user.enabled) return reply.code(403).send({ error: 'account is disabled' });
      await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date(), ...(email ? { email } : {}) } });
      issueSession(reply, user.id);
      return reply.redirect('/');
    } catch (error) {
      app.log.warn({ error }, 'OIDC callback failed');
      return reply.code(401).send({ error: 'OIDC sign-in failed' });
    }
  });
}

async function uniqueUsername(prisma: PrismaClient, base: string) {
  let candidate = base;
  for (let suffix = 2; await prisma.user.findUnique({ where: { username: candidate } }); suffix += 1) candidate = `${base.slice(0, 43)}-${suffix}`;
  return candidate;
}