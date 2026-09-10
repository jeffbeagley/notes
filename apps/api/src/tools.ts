import type { PrismaClient } from '@prisma/client';
import { replaceContextChunks, sanitizeForAssistant } from './context.js';
import { journalBody, localDate } from './journal.js';

// OpenAI-compatible tool/function schemas exposed to the assistant.
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search the user\'s notes, journals, and tasks by keyword. Returns matching document ids, titles, dates, and short snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords to search for.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document',
      description: 'Fetch the full markdown body of a specific note or journal by id, e.g. after finding it with search_notes.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The document id.' },
          type: { type: 'string', enum: ['note', 'journal'], description: 'The document type.' },
        },
        required: ['id', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Create a new note for the user. Call list_places first when the note belongs in a specific notebook; otherwise it is created unfiled.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title.' },
          bodyMarkdown: { type: 'string', description: 'Note body in Markdown.' },
          tagNames: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags.' },
          notebookId: { type: 'string', description: 'Optional notebook id from list_places to file the note into.' },
        },
        required: ['title', 'bodyMarkdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_places',
      description: 'List the user\'s places and the notebooks inside each one. Use the returned notebook ids with create_note to file a note in the right place.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_note',
      description: 'Update an existing note: rename it, rewrite its body, move it to a different notebook, unfile it, retag it, or archive it. Only the fields you pass are changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The note id.' },
          title: { type: 'string', description: 'New title.' },
          bodyMarkdown: { type: 'string', description: 'Replacement body in Markdown.' },
          notebookId: { type: 'string', description: 'Notebook id to move the note into. Pass an empty string to unfile it.' },
          tagNames: { type: 'array', items: { type: 'string' }, description: 'Replacement lowercase tags.' },
          archived: { type: 'boolean', description: 'Archive or unarchive the note.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List the user\'s notes, optionally scoped to one notebook, one place, or only unfiled notes. Use this to see what a notebook contains.',
      parameters: {
        type: 'object',
        properties: {
          notebookId: { type: 'string', description: 'Only notes in this notebook.' },
          placeId: { type: 'string', description: 'Only notes in notebooks belonging to this place.' },
          unfiled: { type: 'boolean', description: 'Only notes that are not in any notebook.' },
          archived: { type: 'boolean', description: 'List archived notes instead of active ones.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_notebook',
      description: 'Create a notebook inside an existing place, for when no current notebook suits the note being filed. Call list_places first to pick the place.',
      parameters: {
        type: 'object',
        properties: {
          placeId: { type: 'string', description: 'Id of the place to create the notebook in.' },
          name: { type: 'string', description: 'Notebook name.' },
          description: { type: 'string', description: 'Optional short description.' },
        },
        required: ['placeId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_choice',
      description: 'Ask the user to pick from a short list of options, then stop and wait. Use this instead of guessing when a decision is the user\'s to make, most importantly where a new note should live: call list_places first, then offer the best-fitting notebooks plus "Create a new notebook" and "Leave it unfiled". Do not call any other tool in the same turn and do not act on an answer you have not received yet.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to show above the options, e.g. "Where should I file this note?".' },
          options: {
            type: 'array',
            description: 'Two to six options for the user to choose between.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short button text, e.g. the notebook name.' },
                value: { type: 'string', description: 'The instruction sent back as the user\'s reply if they pick this, e.g. \'File it in the "Family" notebook (notebookId: abc123)\'. Include any ids you will need.' },
                hint: { type: 'string', description: 'Optional one-line explanation shown under the label.' },
              },
              required: ['label', 'value'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List the user\'s tasks, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['todo', 'doing', 'done', 'cancelled'], description: 'Filter by status.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task for the user.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title.' },
          dueDate: { type: 'string', description: 'Optional due date, YYYY-MM-DD.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_journal_entry',
      description: 'Append an entry to the user\'s journal for a given day (defaults to today), creating the journal if it does not exist yet.',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'The journal entry text to add, in Markdown.' },
          date: { type: 'string', description: 'Optional date for the journal entry, YYYY-MM-DD. Defaults to today.' },
        },
        required: ['entry'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_summaries',
      description: 'List the user\'s generated period summaries (week/month/quarter/year), optionally filtered by period. Returns ids, titles, and period keys; use get_document with type "note" to fetch the full body.',
      parameters: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['week', 'month', 'quarter', 'year'], description: 'Filter by period.' } },
      },
    },
  },
] as const;

export type ToolCallRequest = { id: string; name: string; args: Record<string, unknown> };
export type ToolCallSource = { id: string; type: 'note' | 'journal' | 'task'; title: string; date: string };
export type ToolChoiceOption = { label: string; value: string; hint?: string };
export type ToolChoicePrompt = { question: string; options: ToolChoiceOption[] };
export type ToolCallResult = { ok: boolean; summary: string; content: string; source?: ToolCallSource; refresh?: 'notes' | 'tasks' | 'journals'; choices?: ToolChoicePrompt };
export type ToolExecutionContext = { journalDate?: string; noteId?: string };

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function parseToolCall(id: string, name: string, argsJson: string): ToolCallRequest {
  return { id, name, args: parseArgs(argsJson) };
}

/// "Place / Notebook" breadcrumb so the assistant can say where a note lives and reason about moving it.
async function noteLocations(prisma: PrismaClient, userId: string, noteIds: string[]) {
  if (!noteIds.length) return new Map<string, string>();
  const notes = await prisma.note.findMany({
    where: { userId, id: { in: noteIds } },
    select: { id: true, notebook: { select: { name: true, place: { select: { name: true } } } } },
  });
  return new Map(notes.map((note) => [note.id, note.notebook ? `${note.notebook.place.name} / ${note.notebook.name}` : 'Unfiled']));
}

async function searchNotes(prisma: PrismaClient, userId: string, query: string): Promise<ToolCallResult> {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))].slice(0, 6);
  if (!terms.length) return { ok: false, summary: 'No search terms provided', content: 'No search terms provided.' };
  const [chunks, tasks] = await Promise.all([
    prisma.contextChunk.findMany({
      where: { userId, OR: terms.flatMap((term) => [{ title: { contains: term, mode: 'insensitive' as const } }, { heading: { contains: term, mode: 'insensitive' as const } }, { content: { contains: term, mode: 'insensitive' as const } }]) },
      orderBy: { updatedAt: 'desc' },
      take: 8,
    }),
    prisma.task.findMany({
      where: { userId, OR: terms.flatMap((term) => [{ title: { contains: term, mode: 'insensitive' as const } }, { notes: { contains: term, mode: 'insensitive' as const } }]) },
      take: 8,
    }),
  ]);
  const locations = await noteLocations(prisma, userId, chunks.filter((chunk) => chunk.documentType === 'note').map((chunk) => chunk.documentId));
  const noteHits = chunks.map((chunk) => {
    const suffix = chunk.documentType === 'note' ? `, url: /notes/${chunk.documentId}, in: ${locations.get(chunk.documentId) ?? 'Unfiled'}` : '';
    return `- [${chunk.documentType}] "${chunk.title}" (id: ${chunk.documentId}${suffix}, updated: ${chunk.updatedAt.toISOString().split('T')[0]}): ${chunk.content.slice(0, 160)}`;
  });
  const taskHits = tasks.map((task) => `- [task] "${task.title}" (id: ${task.id}, status: ${task.status})`);
  const lines = [...noteHits, ...taskHits];
  const content = lines.length ? lines.join('\n') : 'No matching notes, journals, or tasks found.';
  return { ok: true, summary: `Found ${lines.length} result(s) for "${query}"`, content };
}

async function getDocument(prisma: PrismaClient, userId: string, id: string, type: string): Promise<ToolCallResult> {
  if (type === 'journal') {
    const journal = await prisma.journal.findFirst({ where: { id, userId } });
    if (!journal) return { ok: false, summary: 'Journal not found', content: 'Journal not found.' };
    return { ok: true, summary: `Journal - ${journal.journalDate.toISOString().split('T')[0]}`, content: sanitizeForAssistant(journal.bodyMarkdown) };
  }
  const note = await prisma.note.findFirst({ where: { id, userId }, include: { notebook: { select: { name: true, place: { select: { name: true } } } } } });
  if (!note) return { ok: false, summary: 'Note not found', content: 'Note not found.' };
  const location = note.notebook ? `${note.notebook.place.name} / ${note.notebook.name}` : 'Unfiled';
  return { ok: true, summary: note.title, content: `Title: ${note.title}\nUrl: /notes/${note.id}\nLocation: ${location}\n\n${sanitizeForAssistant(note.bodyMarkdown)}` };
}

async function listPlaces(prisma: PrismaClient, userId: string): Promise<ToolCallResult> {
  const places = await prisma.place.findMany({
    where: { userId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { notebooks: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } } },
  });
  const lines = places.map((place) => {
    const notebooks = place.notebooks.map((notebook) => `    - notebook "${notebook.name}" (notebookId: ${notebook.id})`);
    return [`- place "${place.name}" (id: ${place.id})`, ...(notebooks.length ? notebooks : ['    - (no notebooks yet)'])].join('\n');
  });
  const content = lines.length ? lines.join('\n') : 'No places yet. Notes created now will be unfiled.';
  return { ok: true, summary: `${places.length} place(s)`, content };
}

async function createNote(prisma: PrismaClient, userId: string, title: string, bodyMarkdown: string, tagNames: string[], notebookId?: string): Promise<ToolCallResult> {
  const tags = [...new Set(tagNames.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const notebook = notebookId ? await prisma.notebook.findFirst({ where: { id: notebookId, userId }, select: { id: true, name: true } }) : null;
  if (notebookId && !notebook) return { ok: false, summary: 'Notebook not found', content: `No notebook with id ${notebookId}. Call list_places to get valid notebook ids.` };
  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.note.create({
      data: {
        userId, title: title.trim() || 'Untitled note', bodyMarkdown, notebookId: notebook?.id ?? null,
        tags: { create: tags.map((name) => ({ tag: { connectOrCreate: { where: { userId_name: { userId, name } }, create: { userId, name } } } })) },
      },
    });
    await replaceContextChunks(tx, userId, 'note', created.id, created.title, bodyMarkdown);
    return created;
  });
  const location = notebook ? `in notebook "${notebook.name}"` : 'unfiled';
  return {
    ok: true,
    summary: `Created note "${note.title}" (id: ${note.id})`,
    content: `Created note "${note.title}" ${location}. Url: /notes/${note.id}`,
    source: { id: note.id, type: 'note', title: note.title, date: note.updatedAt.toISOString().split('T')[0] },
    refresh: 'notes',
  };
}

async function updateNote(prisma: PrismaClient, userId: string, id: string, changes: { title?: string; bodyMarkdown?: string; notebookId?: string; tagNames?: string[]; archived?: boolean }): Promise<ToolCallResult> {
  const existing = await prisma.note.findFirst({ where: { id, userId, type: 'note' } });
  if (!existing) return { ok: false, summary: 'Note not found', content: `No note with id ${id}. Use search_notes or list_notes to find it.` };

  // An empty string is the model's way of asking to unfile, which is distinct from omitting the field.
  const movingTo = changes.notebookId === undefined ? undefined : changes.notebookId.trim() || null;
  const notebook = movingTo ? await prisma.notebook.findFirst({ where: { id: movingTo, userId }, select: { id: true, name: true } }) : null;
  if (movingTo && !notebook) return { ok: false, summary: 'Notebook not found', content: `No notebook with id ${movingTo}. Call list_places to get valid notebook ids.` };

  const tags = changes.tagNames === undefined ? undefined : [...new Set(changes.tagNames.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const note = await prisma.$transaction(async (tx) => {
    const saved = await tx.note.update({
      where: { id: existing.id },
      data: {
        ...(changes.title === undefined ? {} : { title: changes.title.trim() || 'Untitled note' }),
        ...(changes.bodyMarkdown === undefined ? {} : { bodyMarkdown: changes.bodyMarkdown }),
        ...(movingTo === undefined ? {} : { notebookId: movingTo }),
        ...(changes.archived === undefined ? {} : { archived: changes.archived }),
        ...(tags === undefined ? {} : { tags: { deleteMany: {}, create: tags.map((name) => ({ tag: { connectOrCreate: { where: { userId_name: { userId, name } }, create: { userId, name } } } })) } }),
        version: { increment: 1 },
      },
    });
    if (changes.title !== undefined || changes.bodyMarkdown !== undefined) {
      await replaceContextChunks(tx, userId, 'note', saved.id, saved.title, saved.bodyMarkdown);
    }
    return saved;
  });

  const applied = [
    changes.title === undefined ? null : 'renamed',
    changes.bodyMarkdown === undefined ? null : 'body updated',
    movingTo === undefined ? null : movingTo ? `moved to "${notebook?.name}"` : 'unfiled',
    tags === undefined ? null : 'retagged',
    changes.archived === undefined ? null : changes.archived ? 'archived' : 'unarchived',
  ].filter(Boolean).join(', ') || 'no changes requested';
  return {
    ok: true,
    summary: `Updated note "${note.title}" (${applied})`,
    content: `Updated note "${note.title}": ${applied}. Url: /notes/${note.id}`,
    source: { id: note.id, type: 'note', title: note.title, date: note.updatedAt.toISOString().split('T')[0] },
    refresh: 'notes',
  };
}

async function listNotes(prisma: PrismaClient, userId: string, filter: { notebookId?: string; placeId?: string; unfiled?: boolean; archived?: boolean }): Promise<ToolCallResult> {
  const notes = await prisma.note.findMany({
    where: {
      userId,
      type: 'note',
      archived: filter.archived ?? false,
      ...(filter.unfiled ? { notebookId: null } : {}),
      ...(filter.notebookId ? { notebookId: filter.notebookId } : {}),
      ...(filter.placeId ? { notebook: { placeId: filter.placeId } } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }],
    include: { notebook: { select: { name: true, place: { select: { name: true } } } } },
    take: 50,
  });
  const lines = notes.map((note) => `- "${note.title}" (id: ${note.id}, url: /notes/${note.id}, in: ${note.notebook ? `${note.notebook.place.name} / ${note.notebook.name}` : 'Unfiled'}, updated: ${note.updatedAt.toISOString().split('T')[0]})`);
  return { ok: true, summary: `${notes.length} note(s)`, content: lines.length ? lines.join('\n') : 'No notes matched that filter.' };
}

async function createNotebook(prisma: PrismaClient, userId: string, placeId: string, name: string, description?: string): Promise<ToolCallResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, summary: 'Notebook name required', content: 'A notebook name is required.' };
  const place = await prisma.place.findFirst({ where: { id: placeId, userId }, select: { id: true, name: true } });
  if (!place) return { ok: false, summary: 'Place not found', content: `No place with id ${placeId}. Call list_places to get valid place ids.` };
  const duplicate = await prisma.notebook.findFirst({ where: { userId, placeId: place.id, name: trimmedName }, select: { id: true } });
  if (duplicate) return { ok: true, summary: `Notebook "${trimmedName}" already exists`, content: `A notebook named "${trimmedName}" already exists in "${place.name}" (notebookId: ${duplicate.id}). Use it instead of creating another.` };
  const last = await prisma.notebook.findFirst({ where: { userId, placeId: place.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
  const notebook = await prisma.notebook.create({
    data: { userId, placeId: place.id, name: trimmedName, description: description?.trim() || null, sortOrder: (last?.sortOrder ?? -1) + 1 },
  });
  return {
    ok: true,
    summary: `Created notebook "${notebook.name}" in "${place.name}"`,
    content: `Created notebook "${notebook.name}" in place "${place.name}" (notebookId: ${notebook.id}). Url: /notebooks/${notebook.id}`,
    refresh: 'notes',
  };
}

function askUserChoice(question: string, options: unknown): ToolCallResult {
  const parsed = (Array.isArray(options) ? options : [])
    .map((option) => (option && typeof option === 'object' ? option as Record<string, unknown> : {}))
    .map((option) => ({
      label: String(option.label ?? '').trim().slice(0, 80),
      value: String(option.value ?? option.label ?? '').trim().slice(0, 300),
      hint: option.hint === undefined ? undefined : String(option.hint).trim().slice(0, 120) || undefined,
    }))
    .filter((option) => option.label && option.value)
    .slice(0, 6);
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion || parsed.length < 2) {
    return { ok: false, summary: 'Invalid choice prompt', content: 'A question and at least two options with a label and value are required.' };
  }
  return {
    ok: true,
    summary: trimmedQuestion,
    content: `Presented these options to the user as clickable buttons: ${parsed.map((option) => option.label).join(', ')}. Stop now and wait for their reply. Reply with at most one short sentence and do not restate the options, because the interface already renders them. Do not pick for them and do not call another tool.`,
    choices: { question: trimmedQuestion, options: parsed },
  };
}

async function listTasks(prisma: PrismaClient, userId: string, status?: string): Promise<ToolCallResult> {  const tasks = await prisma.task.findMany({
    where: { userId, ...(status ? { status: status as never } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: 30,
  });
  const lines = tasks.map((task) => `- "${task.title}" (id: ${task.id}, status: ${task.status}${task.dueDate ? `, due: ${task.dueDate.toISOString().split('T')[0]}` : ''})`);
  return { ok: true, summary: `${tasks.length} task(s)`, content: lines.length ? lines.join('\n') : 'No tasks found.' };
}

async function createTask(prisma: PrismaClient, userId: string, title: string, dueDate?: string): Promise<ToolCallResult> {
  const task = await prisma.task.create({
    data: { userId, title: title.trim(), dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null, sourceType: 'inbox' },
  });
  return {
    ok: true,
    summary: `Created task "${task.title}" (id: ${task.id})`,
    content: `Created task "${task.title}" with id ${task.id}.`,
    source: { id: task.id, type: 'task', title: task.title, date: task.createdAt.toISOString().split('T')[0] },
    refresh: 'tasks',
  };
}

function insertIntoNotesSection(bodyMarkdown: string, entry: string) {
  const headingMatch = /^## Notes\s*$/m.exec(bodyMarkdown);
  if (!headingMatch) {
    const separator = bodyMarkdown.trim().length ? '\n\n' : '';
    return `${bodyMarkdown}${separator}## Notes\n\n${entry}\n`;
  }
  const insertAt = headingMatch.index + headingMatch[0].length;
  return `${bodyMarkdown.slice(0, insertAt)}\n\n${entry}${bodyMarkdown.slice(insertAt)}`;
}

function insertIntoTasksSection(bodyMarkdown: string, title: string) {
  const taskLine = `- [ ] ${title}`;
  const headingMatch = /^## Tasks\s*$/m.exec(bodyMarkdown);
  if (!headingMatch) {
    const separator = bodyMarkdown.trim().length ? '\n\n' : '';
    return `${bodyMarkdown}${separator}## Tasks\n\n${taskLine}\n`;
  }
  const afterHeading = headingMatch.index + headingMatch[0].length;
  const nextHeadingMatch = /^##\s+/m.exec(bodyMarkdown.slice(afterHeading));
  const sectionEnd = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : bodyMarkdown.length;
  const section = bodyMarkdown.slice(afterHeading, sectionEnd);
  const emptyTaskMatch = /^\s*- \[ \]\s*$/m.exec(section);
  if (emptyTaskMatch) {
    const start = afterHeading + emptyTaskMatch.index;
    const end = start + emptyTaskMatch[0].length;
    return `${bodyMarkdown.slice(0, start)}${taskLine}${bodyMarkdown.slice(end)}`;
  }
  return `${bodyMarkdown.slice(0, sectionEnd).replace(/\s*$/, '\n\n')}${taskLine}\n${bodyMarkdown.slice(sectionEnd).replace(/^\n?/, '\n')}`;
}

async function appendToNote(prisma: PrismaClient, userId: string, noteId: string, entry: string): Promise<ToolCallResult> {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) return { ok: false, summary: 'No note text provided', content: 'No note text provided.' };
  const existing = await prisma.note.findFirst({ where: { id: noteId, userId, type: 'note' } });
  if (!existing) return { ok: false, summary: 'Note not found', content: 'The current note was not found.' };
  const separator = existing.bodyMarkdown.trim().length ? '\n\n' : '';
  const bodyMarkdown = `${existing.bodyMarkdown}${separator}${trimmedEntry}\n`;
  const note = await prisma.$transaction(async (tx) => {
    const saved = await tx.note.update({ where: { id: existing.id }, data: { bodyMarkdown, version: { increment: 1 } } });
    await replaceContextChunks(tx, userId, 'note', saved.id, saved.title, bodyMarkdown);
    return saved;
  });
  return {
    ok: true,
    summary: `Added note text to "${note.title}"`,
    content: `Added note text to "${note.title}". Url: /notes/${note.id}`,
    source: { id: note.id, type: 'note', title: note.title, date: note.updatedAt.toISOString().split('T')[0] },
    refresh: 'notes',
  };
}

async function createNoteTask(prisma: PrismaClient, userId: string, noteId: string, title: string): Promise<ToolCallResult> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return { ok: false, summary: 'Task title required', content: 'A task title is required.' };
  const existing = await prisma.note.findFirst({ where: { id: noteId, userId, type: 'note' } });
  if (!existing) return { ok: false, summary: 'Note not found', content: 'The current note was not found.' };
  const { note, task } = await prisma.$transaction(async (tx) => {
    const bodyMarkdown = insertIntoTasksSection(existing.bodyMarkdown, trimmedTitle);
    const savedNote = await tx.note.update({ where: { id: existing.id }, data: { bodyMarkdown, version: { increment: 1 } } });
    const lastTask = await tx.task.findFirst({ where: { userId, sourceType: 'note', sourceId: savedNote.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const savedTask = await tx.task.create({ data: { userId, title: trimmedTitle, sourceType: 'note', sourceId: savedNote.id, sortOrder: (lastTask?.sortOrder ?? -1) + 1 } });
    await replaceContextChunks(tx, userId, 'note', savedNote.id, savedNote.title, bodyMarkdown);
    return { note: savedNote, task: savedTask };
  });
  return {
    ok: true,
    summary: `Added task "${task.title}" to "${note.title}"`,
    content: `Added task "${task.title}" to "${note.title}" (note id: ${note.id}, task id: ${task.id}).`,
    source: { id: task.id, type: 'task', title: task.title, date: task.createdAt.toISOString().split('T')[0] },
    refresh: 'notes',
  };
}

async function createJournalTask(prisma: PrismaClient, userId: string, title: string, date?: string): Promise<ToolCallResult> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return { ok: false, summary: 'Task title required', content: 'A task title is required.' };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, summary: 'User not found', content: 'User not found.' };
  const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate(user.timezone);
  const journalDate = new Date(`${dateKey}T00:00:00Z`);
  const { journal, task } = await prisma.$transaction(async (tx) => {
    const existing = await tx.journal.findUnique({ where: { userId_journalDate: { userId, journalDate } } });
    const baseBody = existing?.bodyMarkdown ?? journalBody(dateKey, user.timezone);
    const bodyMarkdown = insertIntoTasksSection(baseBody, trimmedTitle);
    const savedJournal = existing
      ? await tx.journal.update({ where: { id: existing.id }, data: { bodyMarkdown, version: { increment: 1 } } })
      : await tx.journal.create({ data: { userId, journalDate, bodyMarkdown } });
    const lastTask = await tx.task.findFirst({ where: { userId, sourceType: 'journal', sourceId: savedJournal.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const savedTask = await tx.task.create({ data: { userId, title: trimmedTitle, dueDate: journalDate, sourceType: 'journal', sourceId: savedJournal.id, sortOrder: (lastTask?.sortOrder ?? -1) + 1 } });
    await replaceContextChunks(tx, userId, 'journal', savedJournal.id, `Journal - ${dateKey}`, bodyMarkdown);
    return { journal: savedJournal, task: savedTask };
  });
  return {
    ok: true,
    summary: `Added task "${task.title}" to journal for ${dateKey}`,
    content: `Added task "${task.title}" to the ${dateKey} journal (journal id: ${journal.id}, task id: ${task.id}).`,
    source: { id: task.id, type: 'task', title: task.title, date: dateKey },
    refresh: 'journals',
  };
}

async function addJournalEntry(prisma: PrismaClient, userId: string, entry: string, date?: string): Promise<ToolCallResult> {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) return { ok: false, summary: 'No entry text provided', content: 'No entry text provided.' };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, summary: 'User not found', content: 'User not found.' };
  const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate(user.timezone);
  const journalDate = new Date(`${dateKey}T00:00:00Z`);
  const journal = await prisma.$transaction(async (tx) => {
    const existing = await tx.journal.findUnique({ where: { userId_journalDate: { userId, journalDate } } });
    const baseBody = existing?.bodyMarkdown ?? journalBody(dateKey, user.timezone);
    const bodyMarkdown = insertIntoNotesSection(baseBody, trimmedEntry);
    const saved = existing
      ? await tx.journal.update({ where: { id: existing.id }, data: { bodyMarkdown, version: { increment: 1 } } })
      : await tx.journal.create({ data: { userId, journalDate, bodyMarkdown } });
    await replaceContextChunks(tx, userId, 'journal', saved.id, `Journal - ${dateKey}`, bodyMarkdown);
    return saved;
  });
  return {
    ok: true,
    summary: `Added entry to journal for ${dateKey}`,
    content: `Added entry to the ${dateKey} journal (id: ${journal.id}).`,
    source: { id: journal.id, type: 'journal', title: `Journal - ${dateKey}`, date: dateKey },
    refresh: 'journals',
  };
}

async function listSummaries(prisma: PrismaClient, userId: string, period?: string): Promise<ToolCallResult> {
  const summaries = await prisma.note.findMany({
    where: { userId, type: 'summary', ...(period ? { period: period as never } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  });
  const lines = summaries.map((summary) => `- "${summary.title}" (id: ${summary.id}, period: ${summary.period}, periodKey: ${summary.periodKey}, updated: ${summary.updatedAt.toISOString().split('T')[0]})`);
  return { ok: true, summary: `${summaries.length} summary(s)`, content: lines.length ? lines.join('\n') : 'No summaries found.' };
}

export async function executeTool(prisma: PrismaClient, userId: string, name: string, args: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<ToolCallResult> {
  try {
    switch (name) {
      case 'search_notes':
        return await searchNotes(prisma, userId, String(args.query ?? ''));
      case 'get_document':
        return await getDocument(prisma, userId, String(args.id ?? ''), String(args.type ?? 'note'));
      case 'create_note':
        if (context.noteId) return await appendToNote(prisma, userId, context.noteId, [String(args.title ?? '').trim(), String(args.bodyMarkdown ?? '').trim()].filter(Boolean).join('\n\n'));
        if (context.journalDate) return await addJournalEntry(prisma, userId, [String(args.title ?? '').trim(), String(args.bodyMarkdown ?? '').trim()].filter(Boolean).join('\n\n'), context.journalDate);
        return await createNote(prisma, userId, String(args.title ?? ''), String(args.bodyMarkdown ?? ''), Array.isArray(args.tagNames) ? args.tagNames.map(String) : [], typeof args.notebookId === 'string' ? args.notebookId : undefined);
      case 'list_places':
        return await listPlaces(prisma, userId);
      case 'update_note':
        return await updateNote(prisma, userId, context.noteId ?? String(args.id ?? ''), {
          title: typeof args.title === 'string' ? args.title : undefined,
          bodyMarkdown: typeof args.bodyMarkdown === 'string' ? args.bodyMarkdown : undefined,
          notebookId: context.noteId ? undefined : typeof args.notebookId === 'string' ? args.notebookId : undefined,
          tagNames: Array.isArray(args.tagNames) ? args.tagNames.map(String) : undefined,
          archived: context.noteId ? undefined : typeof args.archived === 'boolean' ? args.archived : undefined,
        });
      case 'list_notes':
        return await listNotes(prisma, userId, {
          notebookId: typeof args.notebookId === 'string' ? args.notebookId : undefined,
          placeId: typeof args.placeId === 'string' ? args.placeId : undefined,
          unfiled: args.unfiled === true,
          archived: args.archived === true,
        });
      case 'create_notebook':
        return await createNotebook(prisma, userId, String(args.placeId ?? ''), String(args.name ?? ''), typeof args.description === 'string' ? args.description : undefined);
      case 'ask_user_choice':
        return askUserChoice(String(args.question ?? ''), args.options);
      case 'list_tasks':
        return await listTasks(prisma, userId, typeof args.status === 'string' ? args.status : undefined);
      case 'create_task':
        if (context.noteId) return await createNoteTask(prisma, userId, context.noteId, String(args.title ?? ''));
        if (context.journalDate) return await createJournalTask(prisma, userId, String(args.title ?? ''), context.journalDate);
        return await createTask(prisma, userId, String(args.title ?? ''), typeof args.dueDate === 'string' ? args.dueDate : undefined);
      case 'add_journal_entry':
        return await addJournalEntry(prisma, userId, String(args.entry ?? ''), typeof args.date === 'string' ? args.date : undefined);
      case 'list_summaries':
        return await listSummaries(prisma, userId, typeof args.period === 'string' ? args.period : undefined);
      default:
        return { ok: false, summary: `Unknown tool "${name}"`, content: `Unknown tool "${name}".` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return { ok: false, summary: message, content: message };
  }
}
