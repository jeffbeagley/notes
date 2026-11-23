export type CliCommand =
  | { action: 'help' | 'tools'; json: boolean; username: string }
  | { action: 'call'; json: boolean; username: string; name: string; args: Record<string, unknown> };

export const NOTES_CLI_HELP = `Usage:
  notes tools
  notes search <terms>
  notes get <note|journal> <id>
  notes places
  notes list [--place <id>] [--notebook <id>] [--unfiled] [--archived]
  notes call <tool> [--args '{"key":"value"}']

Options:
  --username <name>  Notes user (default: NOTES_USERNAME or admin)
  --json             Print the complete result as JSON`;

function takeOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function localUsername(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const index = argv.indexOf('--username');
  return (index >= 0 ? argv[index + 1] : undefined) ?? env.NOTES_USERNAME ?? 'admin';
}

export function parseNotesCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  const args = [...argv];
  const username = localUsername(args, env);
  takeOption(args, '--username');
  const json = takeFlag(args, '--json');
  const action = args.shift();
  if (!action || action === 'help' || action === '--help' || action === '-h') return { action: 'help', json, username };
  if (action === 'tools') return { action: 'tools', json, username };
  if (action === 'search') {
    const query = args.join(' ').trim();
    if (!query) throw new Error('search requires one or more terms.');
    return { action: 'call', json, username, name: 'search_notes', args: { query } };
  }
  if (action === 'get') {
    const [type, id] = args;
    if (!type || !id || !['note', 'journal'].includes(type)) throw new Error('get requires <note|journal> <id>.');
    return { action: 'call', json, username, name: 'get_document', args: { type, id } };
  }
  if (action === 'places') return { action: 'call', json, username, name: 'list_places', args: {} };
  if (action === 'list') {
    const placeId = takeOption(args, '--place');
    const notebookId = takeOption(args, '--notebook');
    const unfiled = takeFlag(args, '--unfiled');
    const archived = takeFlag(args, '--archived');
    if (args.length) throw new Error(`Unknown list option: ${args[0]}`);
    return { action: 'call', json, username, name: 'list_notes', args: { ...(placeId ? { placeId } : {}), ...(notebookId ? { notebookId } : {}), ...(unfiled ? { unfiled } : {}), ...(archived ? { archived } : {}) } };
  }
  if (action === 'call') {
    const name = args.shift();
    if (!name) throw new Error('call requires a tool name.');
    const encoded = takeOption(args, '--args') ?? '{}';
    if (args.length) throw new Error(`Unknown call option: ${args[0]}`);
    const parsed = JSON.parse(encoded) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('--args must be a JSON object.');
    return { action: 'call', json, username, name, args: parsed as Record<string, unknown> };
  }
  throw new Error(`Unknown command "${action}".`);
}
