import type { PrismaClient, TaskSourceType, TaskStatus } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { jobQueue, processCarryForward } from './queue.js';
import { replaceContextChunks } from './context.js';

type TaskBody = { title?: string; notes?: string; status?: TaskStatus; dueDate?: string | null; sourceType?: TaskSourceType; sourceId?: string | null; sortOrder?: number };
type JournalBody = { bodyMarkdown?: string; baseVersion?: number; source?: 'autosave' | 'manual' | 'restore' | 'rewrite_apply' };
type CreateJournalBody = { date?: string; bodyMarkdown?: string };

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

export function localDate(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function journalBody(date: string, timezone: string) {
  const heading = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
  return `# ${heading}\n\n## Carry forward\n\n- \n\n## Today's focus\n\n- \n\n## Notes\n\n\n## Tasks\n\n- [ ] \n\n## Wins / notes to future me\n\n`;
}

function markdownTasks(bodyMarkdown: string) {
  return [...bodyMarkdown.matchAll(/^\s*- \[([ xX])\]\s+(.+?)\s*$/gm)]
    .map((match) => ({ title: match[2].trim(), status: match[1].toLowerCase() === 'x' ? 'done' as const : 'todo' as const }))
    .filter((task) => task.title.length > 0);
}

function setMarkdownTaskStatus(bodyMarkdown: string, title: string, status: TaskStatus) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return bodyMarkdown.replace(new RegExp(`^(\\s*- \\[)[ xX](\\]\\s+${escapedTitle}\\s*)$`, 'm'), `$1${status === 'done' ? 'x' : ' '}$2`);
}

function reorderMarkdownTasks(bodyMarkdown: string, titles: string[]) {
  const lines = bodyMarkdown.split('\n');
  const taskIndexes = lines.map((line, index) => /^\s*- \[[ xX]\]\s+(.+?)\s*$/.test(line) ? index : -1).filter((index) => index >= 0);
  const taskLines = taskIndexes.map((index) => lines[index]);
  const orderedLines = titles.map((title) => {
    const index = taskLines.findIndex((line) => line.replace(/^\s*- \[[ xX]\]\s+/, '').trim() === title);
    return index >= 0 ? taskLines.splice(index, 1)[0] : undefined;
  }).filter((line): line is string => Boolean(line));
  taskIndexes.forEach((index, order) => { lines[index] = orderedLines[order] ?? ''; });
  return lines.join('\n');
}

export function registerJournalRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get('/api/v1/journals', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    return { journals: await prisma.journal.findMany({ where: { userId: user.id }, orderBy: { journalDate: 'desc' }, select: { id: true, journalDate: true, bodyMarkdown: true, version: true, updatedAt: true } }) };
  });

  app.get<{ Params: { date: string } }>('/api/v1/journals/:date', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.params.date)) return reply.code(400).send({ error: 'date must use YYYY-MM-DD' });
    const journal = await prisma.journal.findUnique({ where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${request.params.date}T00:00:00Z`) } } });
    if (!journal) return reply.code(404).send({ error: 'journal not found' });
    return { journal };
  });

  app.post<{ Body: CreateJournalBody }>('/api/v1/journals', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const date = request.body.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: 'date must use YYYY-MM-DD' });
    const journalDate = new Date(`${date}T00:00:00Z`);
    const journal = await prisma.journal.upsert({
      where: { userId_journalDate: { userId: user.id, journalDate } },
      create: { userId: user.id, journalDate, bodyMarkdown: request.body.bodyMarkdown ?? journalBody(date, user.timezone) },
      update: { bodyMarkdown: request.body.bodyMarkdown ?? undefined },
    });
    return reply.code(201).send({ journal });
  });

  app.patch<{ Params: { date: string }; Body: JournalBody }>('/api/v1/journals/:date', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.params.date)) return reply.code(400).send({ error: 'date must use YYYY-MM-DD' });
    const journal = await prisma.journal.findUnique({ where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${request.params.date}T00:00:00Z`) } } });
    if (!journal) return reply.code(404).send({ error: 'journal not found' });
    if (request.body.baseVersion !== undefined && request.body.baseVersion !== journal.version) return reply.code(409).send({ error: 'journal has changed', journal });
    const bodyMarkdown = request.body.bodyMarkdown ?? journal.bodyMarkdown;
    const source = request.body.source ?? 'autosave';
    const updated = await prisma.$transaction(async (transaction) => {
      const saved = await transaction.journal.update({ where: { id: journal.id }, data: { bodyMarkdown, version: { increment: 1 } } });
      await replaceContextChunks(transaction, user.id, 'journal', journal.id, `Journal - ${journal.journalDate.toISOString().split('T')[0]}`, bodyMarkdown);
      await transaction.documentDraft.upsert({ where: { documentType_documentId: { documentType: 'journal', documentId: journal.id } }, create: { userId: user.id, documentType: 'journal', documentId: journal.id, bodyMarkdown, baseVersion: saved.version }, update: { bodyMarkdown, baseVersion: saved.version } });
      await transaction.task.deleteMany({ where: { userId: user.id, sourceType: 'journal', sourceId: journal.id } });
      const tasks = markdownTasks(bodyMarkdown);
      if (tasks.length) {
        await transaction.task.createMany({ data: tasks.map((task, sortOrder) => ({ userId: user.id, sourceType: 'journal' as const, sourceId: journal.id, title: task.title, status: task.status, dueDate: journal.journalDate, completedAt: task.status === 'done' ? new Date() : null, sortOrder })) });
      }
      const lastVersion = await transaction.documentVersion.findFirst({ where: { userId: user.id, documentType: 'journal', documentId: journal.id }, orderBy: { createdAt: 'desc' } });
      if (source !== 'autosave' || !lastVersion || Date.now() - lastVersion.createdAt.getTime() >= 5 * 60 * 1000) await transaction.documentVersion.create({ data: { userId: user.id, documentType: 'journal', documentId: journal.id, versionN: saved.version, bodyMarkdown, source } });
      return saved;
    });
    return { journal: updated };
  });

  app.get('/api/v1/journals/today', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const date = localDate(user.timezone);
    const existing = await prisma.journal.findUnique({
      where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } },
    });
    if (existing) {
      return { journal: existing };
    }

    const journal = await prisma.journal.create({
      data: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`), bodyMarkdown: journalBody(date, user.timezone) },
    });

    jobQueue.add('carry_forward', { journalId: journal.id, userId: user.id }).catch(() => {
      processCarryForward(prisma, journal.id, user.id).catch(() => undefined);
    });

    return { journal };
  });

  app.patch<{ Body: JournalBody }>('/api/v1/journals/today', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const date = localDate(user.timezone);
    const journal = await prisma.journal.upsert({
      where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } },
      create: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`), bodyMarkdown: journalBody(date, user.timezone) },
      update: {},
    });
    if (request.body.baseVersion !== undefined && request.body.baseVersion !== journal.version) {
      return reply.code(409).send({ error: 'journal has changed', journal });
    }
    const bodyMarkdown = request.body.bodyMarkdown ?? journal.bodyMarkdown;
    const source = request.body.source ?? 'autosave';
    const updated = await prisma.$transaction(async (transaction) => {
      const saved = await transaction.journal.update({ where: { id: journal.id }, data: { bodyMarkdown, version: { increment: 1 } } });
      await replaceContextChunks(transaction, user.id, 'journal', journal.id, `Journal - ${journal.journalDate.toISOString().split('T')[0]}`, bodyMarkdown);
      await transaction.documentDraft.upsert({
        where: { documentType_documentId: { documentType: 'journal', documentId: journal.id } },
        create: { userId: user.id, documentType: 'journal', documentId: journal.id, bodyMarkdown, baseVersion: saved.version },
        update: { bodyMarkdown, baseVersion: saved.version },
      });
      await transaction.task.deleteMany({ where: { userId: user.id, sourceType: 'journal', sourceId: journal.id } });
      const tasks = markdownTasks(bodyMarkdown);
      if (tasks.length) {
        await transaction.task.createMany({ data: tasks.map((task, sortOrder) => ({ userId: user.id, sourceType: 'journal' as const, sourceId: journal.id, title: task.title, status: task.status, dueDate: journal.journalDate, completedAt: task.status === 'done' ? new Date() : null, sortOrder })) });
      }
      const lastVersion = await transaction.documentVersion.findFirst({ where: { userId: user.id, documentType: 'journal', documentId: journal.id }, orderBy: { createdAt: 'desc' } });
      if (source !== 'autosave' || !lastVersion || Date.now() - lastVersion.createdAt.getTime() >= 5 * 60 * 1000) {
        await transaction.documentVersion.create({ data: { userId: user.id, documentType: 'journal', documentId: journal.id, versionN: saved.version, bodyMarkdown, source } });
      }
      return saved;
    });
    return { journal: updated };
  });

  app.get('/api/v1/journals/today/versions', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const date = localDate(user.timezone);
    const journal = await prisma.journal.findUnique({ where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } } });
    if (!journal) return { versions: [] };
    return { versions: await prisma.documentVersion.findMany({ where: { userId: user.id, documentType: 'journal', documentId: journal.id }, select: { id: true, versionN: true, title: true, source: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 }) };
  });

  app.post<{ Params: { versionId: string } }>('/api/v1/journals/today/versions/:versionId/restore', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const date = localDate(user.timezone);
    const journal = await prisma.journal.findUnique({ where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } } });
    if (!journal) return reply.code(404).send({ error: 'journal not found' });
    const snapshot = await prisma.documentVersion.findFirst({ where: { id: request.params.versionId, userId: user.id, documentType: 'journal', documentId: journal.id } });
    if (!snapshot) return reply.code(404).send({ error: 'version not found' });
    const restored = await prisma.$transaction(async (transaction) => {
      await transaction.documentVersion.create({ data: { userId: user.id, documentType: 'journal', documentId: journal.id, versionN: journal.version + 1, bodyMarkdown: journal.bodyMarkdown, source: 'restore' } });
      return transaction.journal.update({ where: { id: journal.id }, data: { bodyMarkdown: snapshot.bodyMarkdown, version: { increment: 1 } } });
    });
    return { journal: restored };
  });

  app.post<{ Body: { suggestion: string } }>('/api/v1/journals/today/accept-carry-forward', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const { suggestion } = request.body || {};
    if (!suggestion) return reply.code(400).send({ error: 'suggestion is required' });

    const date = localDate(user.timezone);
    const journal = await prisma.journal.findUnique({
      where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } },
    });
    if (!journal) return reply.code(404).send({ error: 'today journal not found' });

    let body = journal.bodyMarkdown;
    const carryForwardHeader = '## Carry forward\n';
    if (body.includes(carryForwardHeader)) {
      body = body.replace(carryForwardHeader, `${carryForwardHeader}- ${suggestion}\n`);
    } else {
      body += `\n\n${carryForwardHeader}- ${suggestion}\n`;
    }

    const currentMeta = (journal.suggestedCarryForward as { suggestions?: string[] } | null) ?? {};
    const remaining = (currentMeta.suggestions ?? []).filter((s) => s !== suggestion);

    const updated = await prisma.journal.update({
      where: { id: journal.id },
      data: {
        bodyMarkdown: body,
        suggestedCarryForward: { suggestions: remaining },
        version: { increment: 1 },
      },
    });

    return { journal: updated };
  });

  app.post<{ Body: { suggestion?: string; clearAll?: boolean } }>('/api/v1/journals/today/dismiss-carry-forward', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const date = localDate(user.timezone);
    const journal = await prisma.journal.findUnique({
      where: { userId_journalDate: { userId: user.id, journalDate: new Date(`${date}T00:00:00Z`) } },
    });
    if (!journal) return reply.code(404).send({ error: 'today journal not found' });

    const { suggestion, clearAll } = request.body || {};
    let remaining: string[] = [];
    if (!clearAll && suggestion) {
      const currentMeta = (journal.suggestedCarryForward as { suggestions?: string[] } | null) ?? {};
      remaining = (currentMeta.suggestions ?? []).filter((s) => s !== suggestion);
    }

    const updated = await prisma.journal.update({
      where: { id: journal.id },
      data: {
        suggestedCarryForward: { suggestions: remaining },
      },
    });

    return { journal: updated };
  });

  app.get<{ Querystring: { view?: string; status?: string } }>('/api/v1/tasks', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const today = new Date(`${localDate(user.timezone)}T00:00:00Z`);
    const status = request.query.status as TaskStatus | undefined;
    const where = {
      userId: user.id,
      ...(status ? { status } : {}),
      ...(request.query.view === 'inbox' ? { sourceType: 'inbox' as const } : {}),
      ...(request.query.view === 'open' ? { status: { in: ['todo', 'doing'] as TaskStatus[] } } : {}),
      ...(request.query.view === 'closed' ? { status: { in: ['done', 'cancelled'] as TaskStatus[] } } : {}),
      ...(request.query.view === 'today' ? { AND: [{ status: { in: ['todo', 'doing'] as TaskStatus[] } }, { OR: [{ dueDate: { lte: today } }, { dueDate: today }] }] } : {}),
    };
    return { tasks: await prisma.task.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] }) };
  });

  app.post<{ Body: TaskBody }>('/api/v1/tasks', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    const title = request.body.title?.trim();
    if (!user) return;
    if (!title) return reply.code(400).send({ error: 'task title is required' });
    const task = await prisma.task.create({ data: { userId: user.id, title, notes: request.body.notes, status: request.body.status ?? 'todo', dueDate: request.body.dueDate ? new Date(`${request.body.dueDate}T00:00:00Z`) : null, sourceType: request.body.sourceType ?? 'inbox', sourceId: request.body.sourceId ?? null, sortOrder: request.body.sortOrder ?? 0 } });
    return reply.code(201).send({ task });
  });

  app.patch<{ Params: { id: string }; Body: TaskBody }>('/api/v1/tasks/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const task = await prisma.task.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const status = request.body.status;
    const updated = await prisma.task.update({ where: { id: task.id }, data: { ...(request.body.title === undefined ? {} : { title: request.body.title.trim() }), ...(request.body.notes === undefined ? {} : { notes: request.body.notes }), ...(status === undefined ? {} : { status, completedAt: status === 'done' ? new Date() : null }), ...(request.body.dueDate === undefined ? {} : { dueDate: request.body.dueDate ? new Date(`${request.body.dueDate}T00:00:00Z`) : null }), ...(request.body.sortOrder === undefined ? {} : { sortOrder: request.body.sortOrder }) } });
    if (status !== undefined && task.sourceId) {
      if (task.sourceType === 'journal') {
        const journal = await prisma.journal.findFirst({ where: { id: task.sourceId, userId: user.id } });
        if (journal) await prisma.journal.update({ where: { id: journal.id }, data: { bodyMarkdown: setMarkdownTaskStatus(journal.bodyMarkdown, task.title, status), version: { increment: 1 } } });
      }
      if (task.sourceType === 'note') {
        const note = await prisma.note.findFirst({ where: { id: task.sourceId, userId: user.id } });
        if (note) await prisma.note.update({ where: { id: note.id }, data: { bodyMarkdown: setMarkdownTaskStatus(note.bodyMarkdown, task.title, status), version: { increment: 1 } } });
      }
    }
    return { task: updated };
  });

  app.post<{ Body: { ids?: string[] } }>('/api/v1/tasks/reorder', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const ids = request.body.ids;
    if (!ids?.length || new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'a unique ordered task id list is required' });
    const tasks = await prisma.task.findMany({ where: { userId: user.id, id: { in: ids } } });
    if (tasks.length !== ids.length) return reply.code(404).send({ error: 'one or more tasks were not found' });
    const orderedTasks = ids.map((id) => tasks.find((task) => task.id === id)!);
    await prisma.$transaction(async (transaction) => {
      await Promise.all(orderedTasks.map((task, sortOrder) => transaction.task.update({ where: { id: task.id }, data: { sortOrder } })));
      const sourceTasks = new Map<string, typeof orderedTasks>();
      orderedTasks.filter((task) => task.sourceId && (task.sourceType === 'note' || task.sourceType === 'journal')).forEach((task) => {
        const key = `${task.sourceType}:${task.sourceId}`;
        sourceTasks.set(key, [...(sourceTasks.get(key) ?? []), task]);
      });
      for (const [key] of sourceTasks) {
        const [sourceType, sourceId] = key.split(':');
        const sourceGroup = await transaction.task.findMany({ where: { userId: user.id, sourceType: sourceType as 'note' | 'journal', sourceId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
        const titles = sourceGroup.map((task) => task.title);
        if (sourceType === 'note') {
          const note = await transaction.note.findFirst({ where: { id: sourceId, userId: user.id } });
          if (note) await transaction.note.update({ where: { id: note.id }, data: { bodyMarkdown: reorderMarkdownTasks(note.bodyMarkdown, titles), version: { increment: 1 } } });
        }
        if (sourceType === 'journal') {
          const journal = await transaction.journal.findFirst({ where: { id: sourceId, userId: user.id } });
          if (journal) await transaction.journal.update({ where: { id: journal.id }, data: { bodyMarkdown: reorderMarkdownTasks(journal.bodyMarkdown, titles), version: { increment: 1 } } });
        }
      }
    });
    return { tasks: orderedTasks.map((task, sortOrder) => ({ ...task, sortOrder })) };
  });
}