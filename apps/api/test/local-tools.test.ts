import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TOOL_DEFINITIONS } from '../src/local-tools.js';
import { localUsername, parseNotesCli, parseNotesMcpUsername } from '../src/notes-cli-args.js';
import { localToolAnnotations } from '../src/notes-mcp.js';

test('local adapters expose workspace operations but not assistant-only choice prompts', () => {
  const names = LOCAL_TOOL_DEFINITIONS.map(({ function: tool }) => tool.name);
  assert.ok(names.includes('search_notes'));
  assert.ok(names.includes('create_note'));
  assert.ok(!names.includes('ask_user_choice'));
});

test('CLI aliases map to the shared tool names and arguments', () => {
  assert.deepEqual(parseNotesCli(['search', 'kubernetes', 'debugging'], {}), {
    action: 'call', json: false, username: 'admin', name: 'search_notes', args: { query: 'kubernetes debugging' },
  });
  assert.deepEqual(parseNotesCli(['list', '--place', 'place-1', '--archived', '--username', 'dirk'], {}), {
    action: 'call', json: false, username: 'dirk', name: 'list_notes', args: { placeId: 'place-1', archived: true },
  });
});

test('CLI generic calls accept JSON and reject non-object arguments', () => {
  assert.deepEqual(parseNotesCli(['call', 'create_task', '--args', '{"title":"Review notes"}', '--json'], {}), {
    action: 'call', json: true, username: 'admin', name: 'create_task', args: { title: 'Review notes' },
  });
  assert.throws(() => parseNotesCli(['call', 'create_task', '--args', '[]'], {}), /JSON object/);
  assert.equal(localUsername([], { NOTES_USERNAME: 'local-user' }), 'local-user');
});
test('MCP options fail closed instead of silently selecting another user', () => {
  assert.equal(parseNotesMcpUsername(['--username', 'dirk'], {}), 'dirk');
  assert.throws(() => parseNotesMcpUsername(['--username'], {}), /requires a value/);
  assert.throws(() => parseNotesMcpUsername(['--user', 'dirk'], {}), /Unknown MCP option/);
});
test('MCP annotations distinguish reads, additions, and destructive updates', () => {
  assert.deepEqual(localToolAnnotations('search_notes'), { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(localToolAnnotations('create_note'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(localToolAnnotations('update_note'), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
});
