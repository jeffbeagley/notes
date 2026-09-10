import type { PrismaClient, SummaryPeriod } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { callLlm, getLlmConfig, llmRouteOptions } from './llm.js';
import { formatNotesForPrompt, sanitizeForAssistant } from './context.js';

type SummaryGenerateBody = {
  period?: SummaryPeriod;
  periodKey?: string;
};

type SummaryCustomBody = {
  start?: string;
  end?: string;
  title?: string;
};

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

function defaultPeriodKey(period: SummaryPeriod): string {
  const now = new Date();
  const year = now.getFullYear();

  if (period === 'month') {
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  if (period === 'quarter') {
    const q = Math.floor(now.getMonth() / 3) + 1;
    return `${year}-Q${q}`;
  }

  if (period === 'year') {
    return `${year}`;
  }

  // week
  return weekKey(now);
}

function utcDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function weekNumber(date: Date): number {
  const year = date.getUTCFullYear();
  const firstJan = utcDate(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - firstJan.getTime()) / 86400000);
  return Math.ceil((dayOfYear + firstJan.getDay() + 1) / 7);
}

function weekKey(date: Date): string {
  return `${date.getUTCFullYear()}-W${String(weekNumber(date)).padStart(2, '0')}`;
}

/// Inverts defaultPeriodKey so a summary only sees material from the period it claims to cover.
function periodRange(period: SummaryPeriod, periodKey: string): { start: Date; endExclusive: Date } {
  const year = Number(periodKey.slice(0, 4));
  const safeYear = Number.isFinite(year) ? year : new Date().getFullYear();

  if (period === 'year') {
    return { start: utcDate(safeYear, 0, 1), endExclusive: utcDate(safeYear + 1, 0, 1) };
  }
  if (period === 'month') {
    const month = Number(periodKey.slice(5, 7)) - 1;
    const safeMonth = Number.isFinite(month) && month >= 0 && month < 12 ? month : 0;
    return { start: utcDate(safeYear, safeMonth, 1), endExclusive: utcDate(safeYear, safeMonth + 1, 1) };
  }
  if (period === 'quarter') {
    const quarter = Number(periodKey.slice(6, 7));
    const safeQuarter = Number.isFinite(quarter) && quarter >= 1 && quarter <= 4 ? quarter : 1;
    const startMonth = (safeQuarter - 1) * 3;
    return { start: utcDate(safeYear, startMonth, 1), endExclusive: utcDate(safeYear, startMonth + 3, 1) };
  }

  // Week numbering mirrors defaultPeriodKey: week 1 starts on Jan 1 and weeks break on the Jan 1 weekday.
  const week = Number(periodKey.slice(6)) || 1;
  const firstJan = utcDate(safeYear, 0, 1);
  const offset = firstJan.getUTCDay();
  const startDay = 7 * (week - 1) - offset;
  const start = new Date(firstJan.getTime() + Math.max(startDay, 0) * 86400000);
  const endExclusive = new Date(firstJan.getTime() + (7 * week - offset) * 86400000);
  return { start, endExclusive };
}

function quarterLabel(periodKey: string) {
  return `Q${periodKey.slice(6)} ${periodKey.slice(0, 4)}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(periodKey: string) {
  const monthIndex = Number(periodKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? periodKey} ${periodKey.slice(0, 4)}`;
}

function weekLabel(periodKey: string, range: { start: Date; endExclusive: Date }) {
  const end = new Date(range.endExclusive.getTime() - 86400000);
  return `Week ${Number(periodKey.slice(6))} · ${range.start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`;
}

function periodLabel(period: SummaryPeriod, periodKey: string, range: { start: Date; endExclusive: Date }) {
  if (period === 'year') return periodKey;
  if (period === 'quarter') return quarterLabel(periodKey);
  if (period === 'month') return monthLabel(periodKey);
  if (period === 'week') return weekLabel(periodKey, range);
  return periodKey;
}

/// The child period one level down the drill-down hierarchy, used to roll summaries up.
const CHILD_PERIOD: Record<SummaryPeriod, SummaryPeriod | null> = {
  year: 'quarter',
  quarter: 'month',
  month: 'week',
  week: null,
  custom: null,
};

/// Per-period-type prompt structure: a week's usable output shape differs from a year's retrospective.
function summaryStructure(period: SummaryPeriod): string {
  if (period === 'week') {
    return `# WEEK Summary - {{periodKey}}

## Highlights
- ...

## Carry-forward Tasks / Open Loops
- ...

## Blockers Mentioned
- ...

## Notes & Journals Touched
- ...`;
  }
  if (period === 'month') {
    return `# MONTH Summary - {{periodKey}}

## Themes
- ...

## Highlights / Accomplishments
- ...

## KPIs or Metrics
(Only include metrics directly mentioned in the text. Never invent numbers.)

## Notable Projects / Notes
- ...

## Open Loops / Carry-forward Themes
- ...

## Suggested Focus for Next Month
- ...`;
  }
  if (period === 'quarter' || period === 'year') {
    return `# ${period.toUpperCase()} Summary - {{periodKey}}

## Goal Progress
- ...

## Trends Across the Period
(Note patterns across the sub-periods covered, e.g. recurring themes or momentum shifts.)

## Retrospective Highlights
- ...

## Risks / Blockers Mentioned
- ...

## Suggested Focus for Next ${period === 'quarter' ? 'Quarter' : 'Year'}
- ...`;
  }
  // custom
  return `# Summary - {{periodKey}}

## Highlights
- ...

## KPIs or Metrics
(Only include metrics directly mentioned in the text. Never invent numbers.)

## Open Loops / Carry-forward Themes
- ...

## Risks / Blockers Mentioned
- ...`;
}

export async function generateSummaryForUser(
  prisma: PrismaClient,
  userId: string,
  period: SummaryPeriod,
  periodKey: string,
  explicitRange?: { start: Date; endExclusive: Date }
) {
  const llmConfig = await getLlmConfig(prisma);
  if (!llmConfig.enabled) {
    throw new Error('LLM provider is not enabled');
  }

  // Gather the user's journals, notes, and tasks from inside the period being summarized
  const { start, endExclusive } = explicitRange ?? periodRange(period, periodKey);
  const windowLabel = `${start.toISOString().split('T')[0]} to ${new Date(endExclusive.getTime() - 86400000).toISOString().split('T')[0]}`;
  const childPeriod = CHILD_PERIOD[period];
  const [journals, notes, tasks, childSummaries] = await Promise.all([
    prisma.journal.findMany({
      where: { userId, journalDate: { gte: start, lt: endExclusive } },
      orderBy: { journalDate: 'asc' },
      take: 60,
    }),
    prisma.note.findMany({
      where: { userId, type: 'note', archived: false, updatedAt: { gte: start, lt: endExclusive } },
      orderBy: { updatedAt: 'desc' },
      include: { notebook: { select: { name: true, place: { select: { name: true } } } } },
      take: 40,
    }),
    prisma.task.findMany({
      where: {
        userId,
        OR: [
          { createdAt: { gte: start, lt: endExclusive } },
          { completedAt: { gte: start, lt: endExclusive } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 80,
    }),
    childPeriod
      ? prisma.note.findMany({
          where: { userId, type: 'summary', period: childPeriod, periodStart: { gte: start }, periodEnd: { lte: endExclusive } },
          orderBy: { periodStart: 'asc' },
          select: { title: true, bodyMarkdown: true, periodKey: true },
        })
      : Promise.resolve([]),
  ]);

  const citations = [
    ...journals.map((j) => ({ type: 'journal', date: j.journalDate.toISOString().split('T')[0], id: j.id })),
    ...notes.map((n) => ({ type: 'note', title: n.title, id: n.id })),
    ...tasks.map((t) => ({ type: 'task', title: t.title, status: t.status, id: t.id })),
    ...childSummaries.map((s) => ({ type: 'summary', title: s.title, periodKey: s.periodKey })),
  ];

  const structure = summaryStructure(period).replace(/\{\{periodKey\}\}/g, periodKey);
  const systemPrompt = `You are a period summary assistant. Generate a structured Markdown summary for the period (${period}: ${periodKey}, covering ${windowLabel}).
Use ONLY the provided sources. Do not invent numbers or KPIs. Include citations referencing dates or titles.
Notes are labelled with the place and notebook they live in; use that to group related work. If a section has no supporting material, write "Nothing recorded this period" rather than inventing content.
${childSummaries.length ? `Existing summaries for the sub-periods inside this range are provided; use them as your primary source for those spans and cross-reference the raw journals/notes/tasks for anything not already covered.` : ''}

Required Markdown Structure:
${structure}
`;

  const journalText = journals.map((j) => `[${j.journalDate.toISOString().split('T')[0]}]\n${sanitizeForAssistant(j.bodyMarkdown)}`).join('\n\n') || 'None.';
  const taskText = tasks.map((t) => `- [${t.status}] ${t.title}`).join('\n') || 'None.';
  const childSummaryText = childSummaries.map((s) => `[${s.periodKey}] ${s.title}\n${sanitizeForAssistant(s.bodyMarkdown)}`).join('\n\n') || 'None.';
  const userPrompt = `Period: ${periodKey} (${windowLabel})\n\n${childPeriod ? `Existing ${childPeriod} summaries:\n${childSummaryText}\n\n` : ''}Journals:\n${journalText}\n\nNotes:\n${formatNotesForPrompt(notes)}\n\nTasks:\n${taskText}`;

  const summaryMarkdown = await callLlm(prisma, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  const title = period === 'custom' ? `Summary - ${windowLabel}` : `${period.toUpperCase()} Summary - ${periodKey}`;

  const summaryNote = await prisma.$transaction(async (tx) => {
    const existing = period === 'custom' ? null : await tx.note.findUnique({ where: { userId_type_periodKey: { userId, type: 'summary', periodKey } } });
    if (existing) {
      await tx.documentVersion.create({
        data: { userId, documentType: 'summary', documentId: existing.id, versionN: existing.version, title: existing.title, bodyMarkdown: existing.bodyMarkdown, source: 'rewrite_apply' },
      });
      return tx.note.update({
        where: { id: existing.id },
        data: { bodyMarkdown: summaryMarkdown, sourceCitations: citations, periodStart: start, periodEnd: endExclusive, version: { increment: 1 } },
      });
    }
    return tx.note.create({
      data: {
        userId,
        type: 'summary',
        period,
        periodKey,
        periodStart: start,
        periodEnd: endExclusive,
        title,
        bodyMarkdown: summaryMarkdown,
        sourceCitations: citations,
      },
    });
  });

  return summaryNote;
}

function yearPeriodKeys(year: number) {
  const quarters = [1, 2, 3, 4].map((q) => `${year}-Q${q}`);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const lastWeek = weekNumber(utcDate(year, 11, 31));
  const weeks = Array.from({ length: lastWeek }, (_, i) => `${year}-W${String(i + 1).padStart(2, '0')}`);
  return { quarters, months, weeks };
}

export function registerSummaryRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get<{ Querystring: { period?: string } }>('/api/v1/summaries', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const period = request.query.period;
    const summaries = await prisma.note.findMany({
      where: { userId: user.id, type: 'summary', ...(period ? { period: period as SummaryPeriod } : {}) },
      orderBy: { updatedAt: 'desc' },
    });

    return { summaries };
  });

  app.get<{ Params: { id: string } }>('/api/v1/summaries/:id', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const summary = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'summary' } });
    if (!summary) return reply.code(404).send({ error: 'summary not found' });
    return { summary };
  });

  app.get<{ Params: { periodKey: string } }>('/api/v1/summaries/by-key/:periodKey', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const summary = await prisma.note.findUnique({ where: { userId_type_periodKey: { userId: user.id, type: 'summary', periodKey: request.params.periodKey } } });
    if (!summary) return reply.code(404).send({ error: 'summary not found' });
    return { summary };
  });

  app.get<{ Querystring: { year?: string } }>('/api/v1/summaries/tree', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const year = Number(request.query.year) || new Date().getFullYear();
    const { quarters, months, weeks } = yearPeriodKeys(year);
    const allKeys = [String(year), ...quarters, ...months, ...weeks];

    const existing = await prisma.note.findMany({
      where: { userId: user.id, type: 'summary', periodKey: { in: allKeys } },
      select: { id: true, period: true, periodKey: true, updatedAt: true },
    });
    const byKey = new Map(existing.map((note) => [note.periodKey, note]));

    const describe = (period: SummaryPeriod, periodKey: string) => {
      const range = periodRange(period, periodKey);
      const found = byKey.get(periodKey);
      return {
        period,
        periodKey,
        label: periodLabel(period, periodKey, range),
        start: range.start.toISOString().split('T')[0],
        end: new Date(range.endExclusive.getTime() - 86400000).toISOString().split('T')[0],
        exists: Boolean(found),
        id: found?.id ?? null,
        updatedAt: found?.updatedAt ?? null,
      };
    };

    return {
      year,
      yearSummary: describe('year', String(year)),
      quarters: quarters.map((key) => describe('quarter', key)),
      months: months.map((key) => describe('month', key)),
      weeks: weeks.map((key) => describe('week', key)),
    };
  });

  app.post<{ Body: SummaryGenerateBody }>('/api/v1/summaries/generate', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const period = request.body.period || 'week';
    const periodKey = request.body.periodKey || defaultPeriodKey(period);

    try {
      const summary = await generateSummaryForUser(prisma, user.id, period, periodKey);
      return { summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Summary generation failed';
      return reply.code(503).send({ error: message });
    }
  });

  app.post<{ Body: SummaryCustomBody }>('/api/v1/summaries/custom', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;

    const startInput = request.body.start ? new Date(request.body.start) : null;
    const endInput = request.body.end ? new Date(request.body.end) : null;
    if (!startInput || !endInput || Number.isNaN(startInput.getTime()) || Number.isNaN(endInput.getTime()) || endInput <= startInput) {
      return reply.code(400).send({ error: 'a valid start and end date are required' });
    }

    const periodKey = `custom-${crypto.randomUUID()}`;
    const endExclusive = new Date(endInput.getTime() + 86400000);

    try {
      const summary = await generateSummaryForUser(prisma, user.id, 'custom', periodKey, { start: startInput, endExclusive });
      return { summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Summary generation failed';
      return reply.code(503).send({ error: message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/summaries/:id/versions', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const summary = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'summary' } });
    if (!summary) return reply.code(404).send({ error: 'summary not found' });
    const versions = await prisma.documentVersion.findMany({
      where: { userId: user.id, documentType: 'summary', documentId: summary.id },
      select: { id: true, versionN: true, source: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { versions };
  });

  app.get<{ Params: { id: string; versionId: string } }>('/api/v1/summaries/:id/versions/:versionId', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const version = await prisma.documentVersion.findFirst({
      where: { id: request.params.versionId, userId: user.id, documentType: 'summary', documentId: request.params.id },
    });
    if (!version) return reply.code(404).send({ error: 'version not found' });
    return { version };
  });
}
