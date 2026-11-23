#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { NOTES_CLI_HELP, parseNotesCli } from './notes-cli-args.js';
import { LOCAL_TOOL_DEFINITIONS, callLocalTool, resolveLocalUser } from './local-tools.js';

async function main() {
  const command = parseNotesCli(process.argv.slice(2));
  if (command.action === 'help') {
    console.log(NOTES_CLI_HELP);
    return;
  }
  if (command.action === 'tools') {
    const tools = LOCAL_TOOL_DEFINITIONS.map(({ function: tool }) => ({ name: tool.name, description: tool.description }));
    console.log(command.json ? JSON.stringify(tools, null, 2) : tools.map(tool => `${tool.name}\t${tool.description}`).join('\n'));
    return;
  }
  if (command.action !== 'call') return;

  const prisma = new PrismaClient();
  let queueStarted = false;
  try {
    const userId = await resolveLocalUser(prisma, command.username);
    const result = await callLocalTool(prisma, userId, command.name, command.args);
    queueStarted = Boolean(result.refresh);
    console.log(command.json ? JSON.stringify(result, null, 2) : result.content);
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (queueStarted) {
      const { closeQueue } = await import('./queue.js');
      await closeQueue();
    }
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
