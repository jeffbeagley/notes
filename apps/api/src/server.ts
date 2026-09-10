import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
import { createApp } from './app.js';
import { closeQueue, startWorker } from './queue.js';
import { resolveSessionSecret } from './auth.js';

// Fail fast before binding a port rather than serving traffic with a forgeable session secret.
resolveSessionSecret();

const app = await createApp(prisma);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15000;

let worker: ReturnType<typeof startWorker> | null = null;

async function start() {
  await prisma.$connect();
  try {
    worker = startWorker(prisma);
  } catch (err) {
    app.log.warn({ err }, 'BullMQ worker failed to initialize');
  }
  await app.listen({ host, port });
}

let stopping = false;

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');

  // Redis and BullMQ keep the event loop alive, so an unclosed connection turns SIGTERM into SIGKILL.
  const timer = setTimeout(() => {
    app.log.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, shutdownTimeoutMs);
  timer.unref();

  try {
    await app.close();
    await worker?.close();
    await closeQueue();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

void start().catch(async (error: unknown) => {
  app.log.error(error, 'server failed to start');
  await prisma.$disconnect();
  process.exit(1);
});