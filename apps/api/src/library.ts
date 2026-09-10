import type { LibraryItemType, PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';

type PlaceBody = { name?: string; description?: string | null; icon?: string | null; color?: string | null; coverMediaId?: string | null };
type NotebookBody = PlaceBody & { placeId?: string };
type LibraryTarget = { targetType?: string; targetId?: string };
type LibraryCard = {
  type: LibraryItemType;
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  subtitle: string;
  placeId?: string | null;
  notebookId?: string | null;
  updatedAt?: Date;
};

const itemTypes = new Set<LibraryItemType>(['place', 'notebook', 'note']);

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

function trimmedOrNull(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value.trim() || null;
}

function parseTarget(body: LibraryTarget) {
  const targetType = body.targetType as LibraryItemType | undefined;
  const targetId = body.targetId?.trim();
  if (!targetType || !itemTypes.has(targetType) || !targetId) return null;
  return { targetType, targetId };
}

/// Confirms the target still exists and belongs to the caller before it is favorited or logged as viewed.
async function targetExists(prisma: PrismaClient, userId: string, targetType: LibraryItemType, targetId: string) {
  if (targetType === 'place') return Boolean(await prisma.place.findFirst({ where: { id: targetId, userId }, select: { id: true } }));
  if (targetType === 'notebook') return Boolean(await prisma.notebook.findFirst({ where: { id: targetId, userId }, select: { id: true } }));
  return Boolean(await prisma.note.findFirst({ where: { id: targetId, userId, type: 'note' }, select: { id: true } }));
}

/// Expands view/favorite rows into display cards, dropping rows whose target has since been deleted.
async function resolveLibraryItems(prisma: PrismaClient, userId: string, rows: { targetType: LibraryItemType; targetId: string }[]) {
  const idsFor = (type: LibraryItemType) => rows.filter((row) => row.targetType === type).map((row) => row.targetId);
  const [places, notebooks, notes] = await Promise.all([
    prisma.place.findMany({ where: { userId, id: { in: idsFor('place') } }, select: { id: true, name: true, icon: true, color: true, description: true } }),
    prisma.notebook.findMany({ where: { userId, id: { in: idsFor('notebook') } }, select: { id: true, name: true, icon: true, color: true, description: true, placeId: true, place: { select: { name: true } } } }),
    prisma.note.findMany({ where: { userId, id: { in: idsFor('note') } }, select: { id: true, title: true, updatedAt: true, notebookId: true, notebook: { select: { name: true, placeId: true, place: { select: { name: true } } } } } }),
  ]);
  const placeMap = new Map(places.map((place) => [place.id, place]));
  const notebookMap = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const noteMap = new Map(notes.map((note) => [note.id, note]));

  return rows.flatMap<LibraryCard>((row) => {
    if (row.targetType === 'place') {
      const place = placeMap.get(row.targetId);
      return place ? [{ type: 'place' as const, id: place.id, title: place.name, icon: place.icon, color: place.color, subtitle: place.description ?? 'Place' }] : [];
    }
    if (row.targetType === 'notebook') {
      const notebook = notebookMap.get(row.targetId);
      return notebook ? [{ type: 'notebook' as const, id: notebook.id, title: notebook.name, icon: notebook.icon, color: notebook.color, subtitle: notebook.place.name, placeId: notebook.placeId }] : [];
    }
    const note = noteMap.get(row.targetId);
    return note
      ? [{ type: 'note' as const, id: note.id, title: note.title, icon: null, color: null, subtitle: note.notebook?.name ?? 'Unfiled', placeId: note.notebook?.placeId ?? null, notebookId: note.notebookId, updatedAt: note.updatedAt }]
      : [];
  });
}

export function registerLibraryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get('/api/v1/places', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const places = await prisma.place.findMany({
      where: { userId: user.id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { notebooks: { select: { id: true, _count: { select: { notes: true } } } } },
    });
    return {
      places: places.map(({ notebooks, ...place }) => ({
        ...place,
        notebookCount: notebooks.length,
        noteCount: notebooks.reduce((total, notebook) => total + notebook._count.notes, 0),
      })),
    };
  });

  app.post<{ Body: PlaceBody }>('/api/v1/places', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const name = request.body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'place name is required' });
    if (await prisma.place.findFirst({ where: { userId: user.id, name } })) {
      return reply.code(409).send({ error: 'a place with that name already exists' });
    }
    const last = await prisma.place.findFirst({ where: { userId: user.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const place = await prisma.place.create({
      data: {
        userId: user.id,
        name,
        description: trimmedOrNull(request.body.description) ?? null,
        icon: trimmedOrNull(request.body.icon) ?? null,
        color: trimmedOrNull(request.body.color) ?? null,
        coverMediaId: request.body.coverMediaId ?? null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    return reply.code(201).send({ place: { ...place, notebookCount: 0, noteCount: 0 } });
  });

  app.get<{ Params: { id: string } }>('/api/v1/places/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const place = await prisma.place.findFirst({
      where: { id: request.params.id, userId: user.id },
      include: { notebooks: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { notes: true } } } } },
    });
    if (!place) return reply.code(404).send({ error: 'place not found' });
    const { notebooks, ...rest } = place;
    return {
      place: { ...rest, notebookCount: notebooks.length, noteCount: notebooks.reduce((total, notebook) => total + notebook._count.notes, 0) },
      notebooks: notebooks.map(({ _count, ...notebook }) => ({ ...notebook, noteCount: _count.notes })),
    };
  });

  app.patch<{ Params: { id: string }; Body: PlaceBody }>('/api/v1/places/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const existing = await prisma.place.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!existing) return reply.code(404).send({ error: 'place not found' });
    const name = request.body.name === undefined ? undefined : request.body.name.trim();
    if (name !== undefined && !name) return reply.code(400).send({ error: 'place name is required' });
    if (name && name !== existing.name && (await prisma.place.findFirst({ where: { userId: user.id, name } }))) {
      return reply.code(409).send({ error: 'a place with that name already exists' });
    }
    const place = await prisma.place.update({
      where: { id: existing.id },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(request.body.description === undefined ? {} : { description: trimmedOrNull(request.body.description) }),
        ...(request.body.icon === undefined ? {} : { icon: trimmedOrNull(request.body.icon) }),
        ...(request.body.color === undefined ? {} : { color: trimmedOrNull(request.body.color) }),
        ...(request.body.coverMediaId === undefined ? {} : { coverMediaId: request.body.coverMediaId }),
      },
    });
    return { place };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/places/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const place = await prisma.place.findFirst({ where: { id: request.params.id, userId: user.id }, include: { notebooks: { select: { id: true } } } });
    if (!place) return reply.code(404).send({ error: 'place not found' });
    const notebookIds = place.notebooks.map((notebook) => notebook.id);
    await prisma.$transaction(async (transaction) => {
      // Notes outlive their container: deleting a place unfiles its notes instead of destroying them.
      await transaction.note.updateMany({ where: { userId: user.id, notebookId: { in: notebookIds } }, data: { notebookId: null } });
      await transaction.favorite.deleteMany({ where: { userId: user.id, targetType: 'notebook', targetId: { in: notebookIds } } });
      await transaction.favorite.deleteMany({ where: { userId: user.id, targetType: 'place', targetId: place.id } });
      await transaction.place.delete({ where: { id: place.id } });
    });
    return reply.code(204).send();
  });

  app.post<{ Body: { ids?: string[] } }>('/api/v1/places/reorder', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const ids = request.body.ids ?? [];
    const owned = await prisma.place.findMany({ where: { userId: user.id, id: { in: ids } }, select: { id: true } });
    if (owned.length !== ids.length) return reply.code(400).send({ error: 'unknown place in ordering' });
    await prisma.$transaction(ids.map((id, sortOrder) => prisma.place.update({ where: { id }, data: { sortOrder } })));
    return reply.code(204).send();
  });

  app.get<{ Querystring: { placeId?: string } }>('/api/v1/notebooks', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const notebooks = await prisma.notebook.findMany({
      where: { userId: user.id, ...(request.query.placeId ? { placeId: request.query.placeId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { notes: true } } },
    });
    return { notebooks: notebooks.map(({ _count, ...notebook }) => ({ ...notebook, noteCount: _count.notes })) };
  });

  app.post<{ Body: NotebookBody }>('/api/v1/notebooks', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const name = request.body.name?.trim();
    const placeId = request.body.placeId?.trim();
    if (!name) return reply.code(400).send({ error: 'notebook name is required' });
    if (!placeId) return reply.code(400).send({ error: 'placeId is required' });
    if (!(await prisma.place.findFirst({ where: { id: placeId, userId: user.id } }))) {
      return reply.code(400).send({ error: 'place not found' });
    }
    if (await prisma.notebook.findFirst({ where: { userId: user.id, placeId, name } })) {
      return reply.code(409).send({ error: 'a notebook with that name already exists in this place' });
    }
    const last = await prisma.notebook.findFirst({ where: { userId: user.id, placeId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const notebook = await prisma.notebook.create({
      data: {
        userId: user.id,
        placeId,
        name,
        description: trimmedOrNull(request.body.description) ?? null,
        icon: trimmedOrNull(request.body.icon) ?? null,
        color: trimmedOrNull(request.body.color) ?? null,
        coverMediaId: request.body.coverMediaId ?? null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    return reply.code(201).send({ notebook: { ...notebook, noteCount: 0 } });
  });

  app.get<{ Params: { id: string } }>('/api/v1/notebooks/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const notebook = await prisma.notebook.findFirst({
      where: { id: request.params.id, userId: user.id },
      include: { place: { select: { id: true, name: true, icon: true, color: true } } },
    });
    if (!notebook) return reply.code(404).send({ error: 'notebook not found' });
    const notes = await prisma.note.findMany({
      where: { userId: user.id, type: 'note', notebookId: notebook.id, archived: false },
      orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }],
      include: { tags: { include: { tag: true } } },
    });
    return {
      notebook: { ...notebook, noteCount: notes.length },
      notes: notes.map((note) => ({ ...note, tags: note.tags.map(({ tag }) => tag.name) })),
    };
  });

  app.patch<{ Params: { id: string }; Body: NotebookBody }>('/api/v1/notebooks/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const existing = await prisma.notebook.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!existing) return reply.code(404).send({ error: 'notebook not found' });
    const name = request.body.name === undefined ? undefined : request.body.name.trim();
    if (name !== undefined && !name) return reply.code(400).send({ error: 'notebook name is required' });
    const placeId = request.body.placeId?.trim();
    if (placeId && !(await prisma.place.findFirst({ where: { id: placeId, userId: user.id } }))) {
      return reply.code(400).send({ error: 'place not found' });
    }
    const targetPlaceId = placeId ?? existing.placeId;
    const targetName = name ?? existing.name;
    if ((targetPlaceId !== existing.placeId || targetName !== existing.name)
      && (await prisma.notebook.findFirst({ where: { userId: user.id, placeId: targetPlaceId, name: targetName, NOT: { id: existing.id } } }))) {
      return reply.code(409).send({ error: 'a notebook with that name already exists in this place' });
    }
    const notebook = await prisma.notebook.update({
      where: { id: existing.id },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(placeId === undefined ? {} : { placeId }),
        ...(request.body.description === undefined ? {} : { description: trimmedOrNull(request.body.description) }),
        ...(request.body.icon === undefined ? {} : { icon: trimmedOrNull(request.body.icon) }),
        ...(request.body.color === undefined ? {} : { color: trimmedOrNull(request.body.color) }),
        ...(request.body.coverMediaId === undefined ? {} : { coverMediaId: request.body.coverMediaId }),
      },
    });
    return { notebook };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/notebooks/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const notebook = await prisma.notebook.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!notebook) return reply.code(404).send({ error: 'notebook not found' });
    await prisma.$transaction(async (transaction) => {
      await transaction.note.updateMany({ where: { userId: user.id, notebookId: notebook.id }, data: { notebookId: null } });
      await transaction.favorite.deleteMany({ where: { userId: user.id, targetType: 'notebook', targetId: notebook.id } });
      await transaction.notebook.delete({ where: { id: notebook.id } });
    });
    return reply.code(204).send();
  });

  app.post<{ Body: { placeId?: string; ids?: string[] } }>('/api/v1/notebooks/reorder', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const placeId = request.body.placeId?.trim();
    const ids = request.body.ids ?? [];
    if (!placeId) return reply.code(400).send({ error: 'placeId is required' });
    const owned = await prisma.notebook.findMany({ where: { userId: user.id, id: { in: ids } }, select: { id: true } });
    if (owned.length !== ids.length) return reply.code(400).send({ error: 'unknown notebook in ordering' });
    await prisma.$transaction(ids.map((id, sortOrder) => prisma.notebook.update({ where: { id }, data: { sortOrder, placeId } })));
    return reply.code(204).send();
  });

  app.get('/api/v1/library/tree', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const [places, notebooks, notes, favorites] = await Promise.all([
      prisma.place.findMany({ where: { userId: user.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, icon: true, color: true, description: true, coverMediaId: true, sortOrder: true } }),
      prisma.notebook.findMany({ where: { userId: user.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, placeId: true, name: true, icon: true, color: true, description: true, coverMediaId: true, sortOrder: true } }),
      prisma.note.findMany({ where: { userId: user.id, type: 'note', archived: false }, orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }], select: { id: true, notebookId: true, title: true, updatedAt: true } }),
      prisma.favorite.findMany({ where: { userId: user.id }, select: { targetType: true, targetId: true } }),
    ]);
    return { places, notebooks, notes, favorites };
  });

  app.get('/api/v1/library/overview', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const [recentRows, popularRows, favoriteRows] = await Promise.all([
      prisma.libraryView.findMany({ where: { userId: user.id }, orderBy: { lastViewedAt: 'desc' }, take: 12, select: { targetType: true, targetId: true } }),
      prisma.libraryView.findMany({ where: { userId: user.id, viewCount: { gt: 1 } }, orderBy: [{ viewCount: 'desc' }, { lastViewedAt: 'desc' }], take: 12, select: { targetType: true, targetId: true } }),
      prisma.favorite.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 24, select: { targetType: true, targetId: true } }),
    ]);
    const [recent, popular, favorites] = await Promise.all([
      resolveLibraryItems(prisma, user.id, recentRows),
      resolveLibraryItems(prisma, user.id, popularRows),
      resolveLibraryItems(prisma, user.id, favoriteRows),
    ]);
    return { recent, popular, favorites };
  });

  app.post<{ Body: LibraryTarget }>('/api/v1/library/views', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const target = parseTarget(request.body);
    if (!target) return reply.code(400).send({ error: 'targetType and targetId are required' });
    if (!(await targetExists(prisma, user.id, target.targetType, target.targetId))) {
      return reply.code(404).send({ error: 'target not found' });
    }
    await prisma.libraryView.upsert({
      where: { userId_targetType_targetId: { userId: user.id, ...target } },
      create: { userId: user.id, ...target },
      update: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/favorites', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const rows = await prisma.favorite.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, select: { targetType: true, targetId: true } });
    return { favorites: rows, items: await resolveLibraryItems(prisma, user.id, rows) };
  });

  app.post<{ Body: LibraryTarget }>('/api/v1/favorites', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const target = parseTarget(request.body);
    if (!target) return reply.code(400).send({ error: 'targetType and targetId are required' });
    if (!(await targetExists(prisma, user.id, target.targetType, target.targetId))) {
      return reply.code(404).send({ error: 'target not found' });
    }
    await prisma.favorite.upsert({
      where: { userId_targetType_targetId: { userId: user.id, ...target } },
      create: { userId: user.id, ...target },
      update: {},
    });
    return reply.code(201).send({ favorite: target });
  });

  app.delete<{ Params: { targetType: string; targetId: string } }>('/api/v1/favorites/:targetType/:targetId', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const target = parseTarget(request.params);
    if (!target) return reply.code(400).send({ error: 'targetType and targetId are required' });
    await prisma.favorite.deleteMany({ where: { userId: user.id, ...target } });
    return reply.code(204).send();
  });
}
