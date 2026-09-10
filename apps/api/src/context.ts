import type { Prisma, PrismaClient } from '@prisma/client';

type ContextClient = PrismaClient | Prisma.TransactionClient;
type DocumentKind = 'note' | 'journal';

export function sanitizeForAssistant(markdown: string) {
  return markdown
    .replace(/:::hide\n[\s\S]*?\n:::/g, '[Hidden content omitted]')
    .replace(/==![\s\S]*?==/g, '[Hidden content omitted]');
}

type LocatedNote = { title: string; bodyMarkdown: string; updatedAt: Date; notebook: { name: string; place: { name: string } } | null };

export function noteLocation(note: Pick<LocatedNote, 'notebook'>) {
  return note.notebook ? `${note.notebook.place.name} / ${note.notebook.name}` : 'Unfiled';
}

/// Shared note rendering for the briefing and summary prompts, with hidden spans stripped and bodies capped.
export function formatNotesForPrompt(notes: LocatedNote[], maxChars = 1200) {
  if (!notes.length) return 'None.';
  return notes
    .map((note) => {
      const body = sanitizeForAssistant(note.bodyMarkdown).trim();
      const truncated = body.length > maxChars ? `${body.slice(0, maxChars)}...` : body;
      return `[Note: ${note.title}] (${noteLocation(note)}, updated ${note.updatedAt.toISOString().split('T')[0]})\n${truncated || '(empty)'}`;
    })
    .join('\n\n');
}

export function chunkMarkdown(markdown: string) {
  const chunks: { heading: string | null; content: string }[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  const push = () => {
    const content = buffer.join('\n').trim();
    if (content) chunks.push({ heading, content });
    buffer = [];
  };
  for (const line of sanitizeForAssistant(markdown).split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      push();
      heading = match[2].trim();
      continue;
    }
    buffer.push(line);
  }
  push();
  return chunks.flatMap((chunk) => chunk.content.match(/[\s\S]{1,1200}(?:\s|$)/g)?.map((content) => ({ ...chunk, content: content.trim() })).filter((item) => item.content) ?? []);
}

export async function replaceContextChunks(client: ContextClient, userId: string, documentType: DocumentKind, documentId: string, title: string, markdown: string) {
  await client.contextChunk.deleteMany({ where: { userId, documentType, documentId } });
  const chunks = chunkMarkdown(markdown);
  if (chunks.length) {
    await client.contextChunk.createMany({ data: chunks.map((chunk, chunkIndex) => ({ userId, documentType, documentId, title, heading: chunk.heading, content: chunk.content, chunkIndex })) });
  }
}

export async function ensureContextChunks(client: PrismaClient, userId: string) {
  const count = await client.contextChunk.count({ where: { userId } });
  if (count) return;
  const [notes, journals] = await Promise.all([
    client.note.findMany({ where: { userId, type: 'note' }, select: { id: true, title: true, bodyMarkdown: true } }),
    client.journal.findMany({ where: { userId }, select: { id: true, journalDate: true, bodyMarkdown: true } }),
  ]);
  await client.$transaction(async (transaction) => {
    for (const note of notes) await replaceContextChunks(transaction, userId, 'note', note.id, note.title, note.bodyMarkdown);
    for (const journal of journals) await replaceContextChunks(transaction, userId, 'journal', journal.id, `Journal - ${journal.journalDate.toISOString().split('T')[0]}`, journal.bodyMarkdown);
  });
}