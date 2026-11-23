import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { closeContextQueue } from './context.js';
import { importOneNoteBackup } from './onenote/import.js';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const source = argument('--source');
const username = argument('--username') ?? 'admin';
const dryRun = process.argv.includes('--dry-run');

if (!source) {
  console.error('Usage: node apps/api/dist/import-onenote.js --source <backup-folder> [--username admin] [--dry-run]');
  process.exit(2);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw new Error(`User "${username}" does not exist.`);
  const summary = await importOneNoteBackup({ prisma, userId: user.id, root: resolve(source), dryRun, progress: console.error });
  console.log(JSON.stringify(summary));
  if (summary.failed) process.exitCode = 1;
} finally {
  await closeContextQueue();
  await prisma.$disconnect();
}
