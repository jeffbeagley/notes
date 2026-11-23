/** Escapes plain text that Markdown would reinterpret structurally. */
export function escapeInline(text: string): string {
  return text.replace(/[[\]`<]/g, '\\$&');
}

export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*\d+)([.)])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(#{1,6}(?=\s|$)|>|\||[-*+](?=\s)|`{3,}|~{3,}|-{3,}$|={3,}$)/, '$1\\$2');
}
