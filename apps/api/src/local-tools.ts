import type { PrismaClient } from '@prisma/client';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

// ask_user_choice is an assistant orchestration primitive, not a standalone operation.
export const LOCAL_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(({ function: tool }) => tool.name !== 'ask_user_choice');
const LOCAL_TOOL_NAMES = new Set<string>(LOCAL_TOOL_DEFINITIONS.map(({ function: tool }) => tool.name));

export async function resolveLocalUser(prisma: PrismaClient, username: string) {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw new Error(`User "${username}" does not exist.`);
  return user.id;
}

export async function callLocalTool(prisma: PrismaClient, userId: string, name: string, args: Record<string, unknown>) {
  if (!LOCAL_TOOL_NAMES.has(name)) return { ok: false, summary: `Unknown tool "${name}"`, content: `Unknown tool "${name}".` };
  return executeTool(prisma, userId, name, args);
}

