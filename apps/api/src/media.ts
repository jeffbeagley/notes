import { createReadStream } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { currentUser } from './auth.js';

const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const allowedFormats = new Set(['png', 'jpeg', 'gif', 'webp']);
const mediaRoot = process.env.MEDIA_ROOT ?? './.data/media';
const mediaRootResolved = resolve(mediaRoot);
const thumbnailEdge = 480;

/// Defence in depth: every filesystem read/write must stay inside MEDIA_ROOT.
function mediaPath(key: string) {
  const full = resolve(mediaRootResolved, key);
  if (full !== mediaRootResolved && !full.startsWith(mediaRootResolved + sep)) {
    throw new Error('media key escapes the media root');
  }
  return full;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

/// Returns the written thumbnail key, or null when the image cannot be decoded.
async function writeThumbnail(content: Buffer, storageKey: string) {
  const thumbnailKey = `${storageKey.replace(/\.[^.]+$/, '')}-thumb.webp`;
  try {
    const thumbnail = await sharp(content, { animated: false })
      .rotate()
      .resize({ width: thumbnailEdge, height: thumbnailEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    await writeFile(mediaPath(thumbnailKey), thumbnail);
    return thumbnailKey;
  } catch {
    return null;
  }
}

export function registerMediaRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024 } });

  app.post('/api/v1/media', { bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'image file is required' });
    if (!allowedTypes.has(upload.mimetype)) return reply.code(415).send({ error: 'only png, jpeg, gif, and webp images are supported' });

    const content = await upload.toBuffer();
    if (upload.file.truncated) return reply.code(413).send({ error: 'image exceeds 10 MB limit' });

    // The declared Content-Type is attacker-controlled, so the real format decides what we store.
    const probed = await sharp(content).metadata().catch(() => null);
    if (!probed?.format || !allowedFormats.has(probed.format)) {
      return reply.code(415).send({ error: 'only png, jpeg, gif, and webp images are supported' });
    }
    const mimeType = `image/${probed.format}`;
    const extension = probed.format === 'jpeg' ? 'jpg' : probed.format;
    const storageKey = `${randomUUID()}.${extension}`;
    await mkdir(mediaRootResolved, { recursive: true });
    await writeFile(mediaPath(storageKey), content, { flag: 'wx' });
    const thumbnailKey = await writeThumbnail(content, storageKey);
    try {
      const media = await prisma.media.create({ data: { userId: user.id, storageKey, thumbnailKey, originalName: basename(upload.filename || `image.${extension}`), mimeType, byteSize: content.length } });
      return reply.code(201).send({ media: { id: media.id, url: `/api/v1/media/${media.id}`, thumbnailUrl: `/api/v1/media/${media.id}?variant=thumb`, mimeType: media.mimeType, byteSize: media.byteSize } });
    } catch (error) {
      await unlink(mediaPath(storageKey)).catch(() => undefined);
      if (thumbnailKey) await unlink(mediaPath(thumbnailKey)).catch(() => undefined);
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { variant?: string } }>('/api/v1/media/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const media = await prisma.media.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!media) return reply.code(404).send({ error: 'media not found' });

    // Stored MIME types are format-verified on upload, but never let a browser sniff past them.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cache-Control', 'private, max-age=3600');

    if (request.query.variant !== 'thumb') {
      reply.type(media.mimeType);
      return reply.send(createReadStream(mediaPath(media.storageKey)));
    }

    // Media predating thumbnail support is backfilled on its first thumbnail request.
    let thumbnailKey = media.thumbnailKey;
    if (!thumbnailKey) {
      const original = await readFile(mediaPath(media.storageKey)).catch(() => null);
      thumbnailKey = original ? await writeThumbnail(original, media.storageKey) : null;
      if (thumbnailKey) await prisma.media.update({ where: { id: media.id }, data: { thumbnailKey } });
    }
    if (!thumbnailKey) {
      reply.type(media.mimeType);
      return reply.send(createReadStream(mediaPath(media.storageKey)));
    }
    reply.type('image/webp');
    return reply.send(createReadStream(mediaPath(thumbnailKey)));
  });
}