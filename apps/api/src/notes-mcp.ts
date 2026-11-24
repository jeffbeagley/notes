#!/usr/bin/env node
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { closeContextQueue } from './context.js';
import { parseNotesMcpUsername } from './notes-cli-args.js';
import { LOCAL_TOOL_DEFINITIONS, callLocalTool, resolveLocalUser } from './local-tools.js';

const READ_ONLY_TOOLS = new Set(['search_notes', 'get_document', 'list_places', 'list_notes', 'list_tasks', 'list_summaries']);
const DESTRUCTIVE_TOOLS = new Set(['update_note']);

export function localToolAnnotations(name: string) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

export function createNotesMcpServer(prisma: PrismaClient, userId: string) {
  const server = new McpServer({ name: 'notes-local', version: '0.1.0' });
  for (const { function: tool } of LOCAL_TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.parameters as JsonSchemaType),
        annotations: localToolAnnotations(tool.name),
      },
      async args => {
        const result = await callLocalTool(prisma, userId, tool.name, args);
        return { content: [{ type: 'text' as const, text: result.content }], isError: !result.ok };
      },
    );
  }
  return server;
}

async function main() {
  const prisma = new PrismaClient();
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= closeContextQueue().finally(() => prisma.$disconnect());
  try {
    const userId = await resolveLocalUser(prisma, parseNotesMcpUsername(process.argv.slice(2)));
    const handle = serveStdio(() => createNotesMcpServer(prisma, userId));
    process.stdin.once('end', () => { void cleanup(); });
    process.stdin.once('close', () => { void cleanup(); });
    process.once('SIGINT', () => { void handle.close().finally(cleanup); });
    console.error('Notes MCP server running locally over stdio.');
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
