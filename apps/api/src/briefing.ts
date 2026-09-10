import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { callLlm, getLlmConfig, llmRouteOptions } from './llm.js';
import { formatNotesForPrompt, sanitizeForAssistant } from './context.js';

const legacyBriefingPrompt = 'You are a personal briefing assistant. Create a clear, actionable "What you should follow up / do today" briefing note in Markdown. Ground only in the user\'s provided journals and open tasks. Cite specific dates and task titles in text.';
const previousDefaultBriefingPrompt = 'You are a personal briefing assistant. Create a clear, actionable "What you should follow up / do today" briefing note in Markdown. Ground only in the user\'s provided journals, notes, and open tasks. Reference specific dates, note titles, and task titles in text, and say so plainly when there is nothing to report rather than inventing follow-ups.';
export const defaultBriefingPrompt = `You are a personal daily briefing assistant.

Your only job is to produce a short Markdown briefing titled for the current date:
# Daily briefing — YYYY-MM-DD

Use ONLY the journals, notes, and open tasks provided in this conversation. Do not invent tasks, people, deadlines, or context. If a source is thin, incomplete, or silent, say so briefly instead of filling gaps.

Do not explain your process, list assumptions, or add a preamble. Output only the briefing.

## Rules
- Ground every item in the provided material. Prefer recent entries over old ones.
- Convert notes into actions. Do not recap the journal unless the recap is needed to make the next step clear.
- Separate what the user should do from what they are waiting on.
- If nothing requires follow-up today, say: "Nothing to follow up on from the provided notes."
- Keep it scannable: short bullets, verbs first, no fluff.
- Include dates, names, and next steps only when they appear in the source.
- Do not moralize, coach, or add motivational language.
- If items conflict, note the conflict and keep both rather than resolving it.

## Output structure
### Do today
- Action items the user can complete today. One bullet per action.
- Format: **Verb + object.** Optional: source cue in parentheses, e.g. (note 9/6), (task: X).

### Follow up
- People, threads, decisions, or unfinished loops that need a nudge.
- Format: **Who/what** — next step. Include last-known status if present.

### Waiting on
- Items blocked on someone else or an external event.
- Format: **Item** — waiting on [person/thing], since [date if known].

### Watch
- Deadlines, appointments, or time-sensitive notes in the next 1–3 days.
- Omit this section if empty.

### Open questions
- Unresolved questions the notes raise but do not answer.
- Omit this section if empty.

If a section has no items, omit the section rather than writing "none," except when the entire briefing has nothing to report.`;

// Users who saved the old default get the notes-aware one; a genuinely custom prompt is left alone.
function briefingInstructions(prompt: string | null) {
  return !prompt?.trim() || [legacyBriefingPrompt, previousDefaultBriefingPrompt].includes(prompt.trim()) ? defaultBriefingPrompt : prompt.trim();
}

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

function localDate(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function registerBriefingRoutes(app: FastifyInstance, prisma: PrismaClient) {
  // Get or Create Today's Briefing
  app.get('/api/v1/briefings/today', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const dateKey = localDate(user.timezone);
    const existing = await prisma.note.findUnique({
      where: { userId_type_periodKey: { userId: user.id, type: 'daily_briefing', periodKey: dateKey } },
    });

    if (existing) {
      return { briefing: existing };
    }

    return { briefing: null, dateKey };
  });

  // Generate / Regenerate Today's Briefing
  app.post('/api/v1/briefings/today/generate', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const dateKey = localDate(user.timezone);
    const llmConfig = await getLlmConfig(prisma);
    if (!llmConfig.enabled) {
      return reply.code(530).send({ error: 'LLM provider is not enabled' });
    }

    // Gather context sources
    const noteWindowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [recentJournals, openTasks, recentNotes] = await Promise.all([
      prisma.journal.findMany({ where: { userId: user.id }, orderBy: { journalDate: 'desc' }, take: 3 }),
      prisma.task.findMany({ where: { userId: user.id, status: { in: ['todo', 'doing'] } }, take: 20 }),
      prisma.note.findMany({
        where: { userId: user.id, type: 'note', archived: false, updatedAt: { gte: noteWindowStart } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        include: { notebook: { select: { name: true, place: { select: { name: true } } } } },
      }),
    ]);

    // Tasks parsed out of note checkboxes are far more useful when the briefing can name the note they came from.
    const taskNoteIds = [...new Set(openTasks.filter((task) => task.sourceType === 'note' && task.sourceId).map((task) => task.sourceId as string))];
    const taskNotes = taskNoteIds.length
      ? await prisma.note.findMany({ where: { userId: user.id, id: { in: taskNoteIds } }, select: { id: true, title: true } })
      : [];
    const taskNoteTitles = new Map(taskNotes.map((note) => [note.id, note.title]));

    const citations = [
      ...recentJournals.map((j) => ({ type: 'journal', date: j.journalDate.toISOString().split('T')[0], id: j.id })),
      ...recentNotes.map((n) => ({ type: 'note', title: n.title, id: n.id })),
      ...openTasks.map((t) => ({ type: 'task', title: t.title, id: t.id })),
    ];

    const systemPrompt = briefingInstructions(user.briefingPrompt);
    const journalText = recentJournals.map((j) => `[${j.journalDate.toISOString().split('T')[0]}]\n${sanitizeForAssistant(j.bodyMarkdown)}`).join('\n\n') || 'None.';
    const taskText = openTasks.map((t) => {
      const source = t.sourceType === 'note' && t.sourceId ? taskNoteTitles.get(t.sourceId) : undefined;
      return `- ${t.title} (due: ${t.dueDate ? t.dueDate.toISOString().split('T')[0] : 'none'}${source ? `, from note "${source}"` : ''})`;
    }).join('\n') || 'None.';
    const userPrompt = `Date: ${dateKey}\n\nRecent Journals:\n${journalText}\n\nNotes updated in the last 7 days:\n${formatNotesForPrompt(recentNotes)}\n\nOpen Tasks:\n${taskText}`;

    try {
      const markdownBody = await callLlm(prisma, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const briefing = await prisma.note.upsert({
        where: { userId_type_periodKey: { userId: user.id, type: 'daily_briefing', periodKey: dateKey } },
        create: {
          userId: user.id,
          type: 'daily_briefing',
          periodKey: dateKey,
          title: `Daily Briefing - ${dateKey}`,
          bodyMarkdown: markdownBody,
          sourceCitations: citations,
        },
        update: {
          bodyMarkdown: markdownBody,
          sourceCitations: citations,
          version: { increment: 1 },
        },
      });

      return { briefing };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Briefing generation failed';
      return reply.code(503).send({ error: msg });
    }
  });
}
