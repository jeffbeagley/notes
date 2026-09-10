import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient, User } from '@prisma/client';

const sessionCookie = 'notes_session';
const maxAgeSeconds = 60 * 60 * 24 * 14;
const developmentSecret = 'development-only-change-me';

type SessionPayload = { sub: string; iat: number; exp: number };

declare module 'fastify' {
  interface FastifyRequest {
    authUser: User | null | undefined;
  }
}

/// Throws when SESSION_SECRET is missing or weak so a public deployment can never fall back to a
/// known signing key — sessions are self-contained HMAC blobs, so a guessable secret is a full
/// authentication bypass.
export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SESSION_SECRET;

  if (!value) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is required. Generate one with: openssl rand -base64 48');
    }
    return developmentSecret;
  }
  if (value === developmentSecret || value === 'change-me' || value === 'change-me-session-secret') {
    throw new Error('SESSION_SECRET is set to a placeholder value. Generate one with: openssl rand -base64 48');
  }
  if (value.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48');
  }
  return value;
}

let cachedSecret: string | null = null;

function secret() {
  cachedSecret ??= resolveSessionSecret();
  return cachedSecret;
}

/// Cookies are secure by default; SECURE_COOKIES=false is the explicit opt-out for plain-HTTP dev.
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.SECURE_COOKIES !== 'false',
    path: '/',
    maxAge,
  };
}

function encode(payload: SessionPayload) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${signature}`;
}

function decode(value: string): SessionPayload | null {
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', secret()).update(encoded).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

export function issueSession(reply: FastifyReply, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  reply.setCookie(sessionCookie, encode({ sub: userId, iat: now, exp: now + maxAgeSeconds }), cookieOptions(maxAgeSeconds));
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(sessionCookie, { path: '/' });
}

export function issueTransientCookie(reply: FastifyReply, name: string, value: string) {
  const now = Math.floor(Date.now() / 1000);
  reply.setCookie(name, encode({ sub: value, iat: now, exp: now + 10 * 60 }), cookieOptions(10 * 60));
}

export function readTransientCookie(request: FastifyRequest, name: string) {
  const session = decode(request.cookies[name] ?? '');
  return session?.sub ?? null;
}

export async function currentUser(request: FastifyRequest, prisma: PrismaClient): Promise<User | null> {
  if (request.authUser !== undefined) return request.authUser;
  request.authUser = await resolveUser(request, prisma);
  return request.authUser;
}

async function resolveUser(request: FastifyRequest, prisma: PrismaClient): Promise<User | null> {
  const session = decode(request.cookies[sessionCookie] ?? '');
  if (!session) return null;
  const user = await prisma.user.findFirst({ where: { id: session.sub, enabled: true } });
  if (!user) return null;
  // Bumping sessionsValidFrom (password change, forced sign-out) revokes every previously issued token.
  if (session.iat * 1000 < user.sessionsValidFrom.getTime()) return null;
  return user;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    timezone: user.timezone,
    forcePasswordChange: user.forcePasswordChange,
  };
}