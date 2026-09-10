import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { PrismaClient } from '@prisma/client';
import { callLlm, getLlmConfig } from './llm.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', name: 'worker' });

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const jobQueue = new Queue('notes-jobs', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  },
});

export async function closeQueue() {
  await jobQueue.close().catch(() => undefined);
  await redisConnection.quit().catch(() => undefined);
}

export async function processCarryForward(prisma: PrismaClient, journalId: string, userId: string) {
  const journal = await prisma.journal.findFirst({ where: { id: journalId, userId } });
  if (!journal) return;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const yesterdayDate = new Date(journal.journalDate.getTime() - 86400000);
  const yesterdayJournal = await prisma.journal.findFirst({
    where: { userId, journalDate: yesterdayDate },
  });

  const openTasks = await prisma.task.findMany({
    where: { userId, status: { in: ['todo', 'doing'] } },
    take: 20,
  });

  const llmConfig = await getLlmConfig(prisma);
  if (!llmConfig.enabled) return;

  const systemPrompt = `You are a personal journal assistant. Analyze yesterday's journal and remaining open tasks. Propose carry-forward items for today. Return JSON: {"suggestions": ["prose item 1", "prose item 2"]}`;
  const userPrompt = `Yesterday's Journal:\n${yesterdayJournal?.bodyMarkdown || 'No entry'}\n\nOpen Tasks:\n${openTasks.map((t) => `- ${t.title}`).join('\n') || 'None'}`;

  try {
    const jsonStr = await callLlm(
      prisma,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { responseFormatJson: true }
    );
    const parsed = JSON.parse(jsonStr) as { suggestions?: string[] };
    const suggestions = (parsed.suggestions ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0);

    await prisma.journal.update({
      where: { id: journal.id },
      data: { suggestedCarryForward: { suggestions } },
    });
  } catch (err) {
    logger.error({ err }, 'failed carry-forward generation');
  }
}

export function startWorker(prisma: PrismaClient) {
  const workerConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const worker = new Worker(
    'notes-jobs',
    async (job) => {
      if (job.name === 'carry_forward') {
        const { journalId, userId } = job.data as { journalId: string; userId: string };
        await processCarryForward(prisma, journalId, userId);
      }
    },
    { connection: workerConnection }
  );

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, jobName: job?.name }, 'job failed');
  });

  return worker;
}
