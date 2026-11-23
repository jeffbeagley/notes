/** A usable extension from a filename, without its leading dot. */
export function extensionFromName(name: string | undefined): string | null {
  return name?.match(/\.([^\.\s\\/]+)$/)?.[1] ?? null;
}
