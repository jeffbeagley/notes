#!/usr/bin/env node
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { localUsername } from './notes-cli-args.js';
import { LOCAL_TOOL_DEFINITIONS, callLocalTool, resolveLocalUser } from './local-tools.js';

const READ_ONLY_TOOLS = new Set(['search_notes', 'get_document', 'list_places', 'list_notes', 'list_tasks', 'list_summaries']);

export function createNotesMcpServer(prisma: PrismaClient, userId: string) {
  const server = new McpServer({ name: 'notes-local', version: '0.1.0' });
  for (const { function: tool } of LOCAL_TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.parameters as JsonSchemaType),
        annotations: {
          readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
          destructiveHint: false,
          idempotentHint: READ_ONLY_TOOLS.has(tool.name),
          openWorldHint: false,
        },
      },
      async args => {
        const result = await callLocalTool(prisma, userId, tool.name, args);
        return { content: [{ type: 'text' as const, text: result.content }], isError: !result.ok };
      },
    );
  }
  server.server.onclose = () => {
    void import('./queue.js').then(({ closeQueue }) => closeQueue()).finally(() => prisma.$disconnect());
  };
  return server;
}

async function main() {
  const prisma = new PrismaClient();
  const userId = await resolveLocalUser(prisma, localUsername(process.argv.slice(2)));
  const handle = serveStdio(() => createNotesMcpServer(prisma, userId));
  process.on('SIGINT', () => { void handle.close(); });
  console.error('Notes MCP server running locally over stdio.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
