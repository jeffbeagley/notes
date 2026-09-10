import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { replaceContextChunks } from './context.js';

type NoteBody = { title?: string; bodyMarkdown?: string; notebookId?: string | null; tagNames?: string[]; archived?: boolean };
type SaveBody = { title?: string; bodyMarkdown?: string; baseVersion?: number; source?: 'autosave' | 'manual' | 'restore' | 'rewrite_apply' };

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

function normalizeTags(tagNames: string[] | undefined) {
  return [...new Set((tagNames ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

function markdownTasks(bodyMarkdown: string) {
  return [...bodyMarkdown.matchAll(/^\s*- \[([ xX])\]\s+(.+?)\s*$/gm)]
    .map((match) => ({ title: match[2].trim(), status: match[1].toLowerCase() === 'x' ? 'done' as const : 'todo' as const }))
    .filter((task) => task.title.length > 0);
}

function serializeNote(note: {
  id: string; title: string; bodyMarkdown: string; notebookId: string | null; archived: boolean; version: number; sortOrder: number; createdAt: Date; updatedAt: Date;
  tags: { tag: { name: string } }[];
}) {
  return { ...note, tags: note.tags.map(({ tag }) => tag.name) };
}

export function registerNoteRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get('/api/v1/tags', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    return { tags: (await prisma.tag.findMany({ where: { userId: user.id }, orderBy: { name: 'asc' } })).map((tag) => tag.name) };
  });

  app.get<{ Querystring: { archived?: string; notebookId?: string; placeId?: string; unfiled?: string; tag?: string } }>('/api/v1/notes', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const where = {
      userId: user.id,
      type: 'note' as const,
      archived: request.query.archived === 'true',
      ...(request.query.unfiled === 'true' ? { notebookId: null } : {}),
      ...(request.query.notebookId ? { notebookId: request.query.notebookId } : {}),
      ...(request.query.placeId ? { notebook: { placeId: request.query.placeId } } : {}),
      ...(request.query.tag ? { tags: { some: { tag: { name: request.query.tag.toLowerCase() } } } } : {}),
    };
    const notes = await prisma.note.findMany({ where, include: { tags: { include: { tag: true } } }, orderBy: { updatedAt: 'desc' } });
    return { notes: notes.map(serializeNote) };
  });

  app.post<{ Body: NoteBody }>('/api/v1/notes', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const title = request.body.title?.trim() || 'Untitled note';
    if (request.body.notebookId && !(await prisma.notebook.findFirst({ where: { id: request.body.notebookId, userId: user.id } }))) {
      return reply.code(400).send({ error: 'notebook not found' });
    }
    const tags = normalizeTags(request.body.tagNames);
    const last = request.body.notebookId
      ? await prisma.note.findFirst({ where: { userId: user.id, notebookId: request.body.notebookId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } })
      : null;
    const note = await prisma.note.create({
      data: {
        userId: user.id, title, bodyMarkdown: request.body.bodyMarkdown ?? '', notebookId: request.body.notebookId ?? null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        tags: { create: tags.map((name) => ({ tag: { connectOrCreate: { where: { userId_name: { userId: user.id, name } }, create: { userId: user.id, name } } } })) },
      }, include: { tags: { include: { tag: true } } },
    });
    return reply.code(201).send({ note: serializeNote(note) });
  });

  app.post<{ Body: { notebookId?: string | null; ids?: string[] } }>('/api/v1/notes/reorder', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const ids = request.body.ids ?? [];
    const notebookId = request.body.notebookId ?? null;
    if (notebookId && !(await prisma.notebook.findFirst({ where: { id: notebookId, userId: user.id } }))) {
      return reply.code(400).send({ error: 'notebook not found' });
    }
    const owned = await prisma.note.findMany({ where: { userId: user.id, type: 'note', id: { in: ids } }, select: { id: true } });
    if (owned.length !== ids.length) return reply.code(400).send({ error: 'unknown note in ordering' });
    await prisma.$transaction(ids.map((id, sortOrder) => prisma.note.update({ where: { id }, data: { sortOrder, notebookId } })));
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/v1/notes/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({
      where: { id: request.params.id, userId: user.id, type: 'note' },
      include: { tags: { include: { tag: true } }, notebook: { include: { place: { select: { id: true, name: true, icon: true, color: true } } } } },
    });
    if (!note) return reply.code(404).send({ error: 'note not found' });
    const { notebook, ...rest } = note;
    return {
      note: serializeNote(rest),
      notebook: notebook ? { id: notebook.id, name: notebook.name, icon: notebook.icon, color: notebook.color, placeId: notebook.placeId } : null,
      place: notebook?.place ?? null,
    };
  });

  app.patch<{ Params: { id: string }; Body: NoteBody }>('/api/v1/notes/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const existing = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'note' } });
    if (!existing) return reply.code(404).send({ error: 'note not found' });
    if (request.body.notebookId && !(await prisma.notebook.findFirst({ where: { id: request.body.notebookId, userId: user.id } }))) {
      return reply.code(400).send({ error: 'notebook not found' });
    }
    const tags = request.body.tagNames === undefined ? undefined : normalizeTags(request.body.tagNames);
    const note = await prisma.note.update({
      where: { id: existing.id },
      data: {
        ...(request.body.title === undefined ? {} : { title: request.body.title.trim() || 'Untitled note' }),
        ...(request.body.bodyMarkdown === undefined ? {} : { bodyMarkdown: request.body.bodyMarkdown }),
        ...(request.body.notebookId === undefined ? {} : { notebookId: request.body.notebookId }),
        ...(request.body.archived === undefined ? {} : { archived: request.body.archived }),
        ...(tags === undefined ? {} : { tags: { deleteMany: {}, create: tags.map((name) => ({ tag: { connectOrCreate: { where: { userId_name: { userId: user.id, name } }, create: { userId: user.id, name } } } })) } }),
        version: { increment: 1 },
      }, include: { tags: { include: { tag: true } } },
    });
    return { note: serializeNote(note) };
  });

  app.patch<{ Params: { id: string }; Body: SaveBody }>('/api/v1/notes/:id/document', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'note' } });
    if (!note) return reply.code(404).send({ error: 'note not found' });
    if (request.body.baseVersion !== undefined && request.body.baseVersion !== note.version) {
      return reply.code(409).send({ error: 'document has changed', note: { id: note.id, title: note.title, bodyMarkdown: note.bodyMarkdown, version: note.version, updatedAt: note.updatedAt } });
    }

    const title = request.body.title ?? note.title;
    const bodyMarkdown = request.body.bodyMarkdown ?? note.bodyMarkdown;
    const source = request.body.source ?? 'autosave';
    const updated = await prisma.$transaction(async (transaction) => {
      const saved = await transaction.note.update({ where: { id: note.id }, data: { title, bodyMarkdown, version: { increment: 1 } } });
      await replaceContextChunks(transaction, user.id, 'note', note.id, title, bodyMarkdown);
      await transaction.task.deleteMany({ where: { userId: user.id, sourceType: 'note', sourceId: note.id } });
      const tasks = markdownTasks(bodyMarkdown);
      if (tasks.length) {
        await transaction.task.createMany({ data: tasks.map((task, sortOrder) => ({ userId: user.id, sourceType: 'note' as const, sourceId: note.id, title: task.title, status: task.status, completedAt: task.status === 'done' ? new Date() : null, sortOrder })) });
      }
      await transaction.documentDraft.upsert({
        where: { documentType_documentId: { documentType: 'note', documentId: note.id } },
        create: { userId: user.id, documentType: 'note', documentId: note.id, title, bodyMarkdown, baseVersion: saved.version },
        update: { title, bodyMarkdown, baseVersion: saved.version },
      });
      const lastVersion = await transaction.documentVersion.findFirst({ where: { userId: user.id, documentType: 'note', documentId: note.id }, orderBy: { createdAt: 'desc' } });
      const shouldSnapshot = source !== 'autosave' || !lastVersion || Date.now() - lastVersion.createdAt.getTime() >= 5 * 60 * 1000;
      if (shouldSnapshot) {
        await transaction.documentVersion.create({ data: { userId: user.id, documentType: 'note', documentId: note.id, versionN: saved.version, title, bodyMarkdown, source } });
      }
      return saved;
    });
    return { note: { id: updated.id, title: updated.title, bodyMarkdown: updated.bodyMarkdown, version: updated.version, updatedAt: updated.updatedAt } };
  });

  app.get<{ Params: { id: string } }>('/api/v1/notes/:id/versions', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'note' } });
    if (!note) return reply.code(404).send({ error: 'note not found' });
    return { versions: await prisma.documentVersion.findMany({ where: { userId: user.id, documentType: 'note', documentId: note.id }, select: { id: true, versionN: true, title: true, source: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }) };
  });

  app.post<{ Params: { id: string; versionId: string } }>('/api/v1/notes/:id/versions/:versionId/restore', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const [note, snapshot] = await Promise.all([
      prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'note' } }),
      prisma.documentVersion.findFirst({ where: { id: request.params.versionId, userId: user.id, documentType: 'note', documentId: request.params.id } }),
    ]);
    if (!note || !snapshot) return reply.code(404).send({ error: 'note or version not found' });
    const restored = await prisma.$transaction(async (transaction) => {
      await transaction.documentVersion.create({ data: { userId: user.id, documentType: 'note', documentId: note.id, versionN: note.version + 1, title: note.title, bodyMarkdown: note.bodyMarkdown, source: 'restore' } });
      return transaction.note.update({ where: { id: note.id }, data: { title: snapshot.title ?? note.title, bodyMarkdown: snapshot.bodyMarkdown, version: { increment: 1 } } });
    });
    return { note: { id: restored.id, title: restored.title, bodyMarkdown: restored.bodyMarkdown, version: restored.version, updatedAt: restored.updatedAt } };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/notes/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const result = await prisma.$transaction(async (transaction) => {
      const deleted = await transaction.note.deleteMany({ where: { id: request.params.id, userId: user.id, type: 'note' } });
      if (!deleted.count) return deleted;
      const noteId = request.params.id;
      // These tables key off documentId/targetId rather than a foreign key, so nothing cascades on their own.
      // Context chunks especially must go, or the deleted note keeps surfacing in search and assistant context.
      await transaction.task.deleteMany({ where: { userId: user.id, sourceType: 'note', sourceId: noteId } });
      await transaction.contextChunk.deleteMany({ where: { userId: user.id, documentType: 'note', documentId: noteId } });
      await transaction.documentVersion.deleteMany({ where: { userId: user.id, documentType: 'note', documentId: noteId } });
      await transaction.documentDraft.deleteMany({ where: { userId: user.id, documentType: 'note', documentId: noteId } });
      await transaction.favorite.deleteMany({ where: { userId: user.id, targetType: 'note', targetId: noteId } });
      await transaction.libraryView.deleteMany({ where: { userId: user.id, targetType: 'note', targetId: noteId } });
      return deleted;
    });
    return result.count ? reply.code(204).send() : reply.code(404).send({ error: 'note not found' });
  });
}