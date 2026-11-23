import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import type { Media, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { removeStoredMedia, storeMedia } from '../media.js';
import { convertPage } from './onefile/convert.js';
import { readSections } from './onefile/package.js';

const BACKUP_SUFFIX = / \(On \d{1,2}-\d{1,2}-\d{4}\)$/;

export interface OneNoteImportSummary {
  files: number;
  sections: number;
  pages: number;
  imported: number;
  skipped: number;
  failed: number;
  attachments: number;
}

interface BackupFile {
  path: string;
  relativePath: string;
  placeName: string;
  groups: string[];
  sectionName: string;
  modifiedMs: number;
}

async function walk(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile() && ['.one', '.onepkg'].includes(extname(entry.name).toLowerCase())) paths.push(path);
  }
  return paths;
}

export async function discoverOneNoteBackups(root: string): Promise<BackupFile[]> {
  const newest = new Map<string, BackupFile>();
  for (const path of await walk(root)) {
    const relativePath = relative(root, path);
    const parts = relativePath.split(sep);
    const fileName = parts.pop()!;
    const extension = extname(fileName).toLowerCase();
    const rawName = basename(fileName, extension);
    const sectionName = extension === '.one' ? rawName.replace(BACKUP_SUFFIX, '') : rawName;
    const placeName = extension === '.onepkg' ? rawName : parts.shift() || 'OneNote';
    const modifiedMs = (await stat(path)).mtimeMs;
    const file = { path, relativePath, placeName, groups: parts, sectionName, modifiedMs };
    const key = extension === '.one' ? `${dirname(relativePath).toLowerCase()}\0${sectionName.toLowerCase()}` : relativePath.toLowerCase();
    const existing = newest.get(key);
    if (!existing || file.modifiedMs > existing.modifiedMs) newest.set(key, file);
  }
  return [...newest.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function mimeType(name: string) {
  const extension = extname(name).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

export async function normalizeOneNoteAttachment(
  bytes: Uint8Array,
  suggestedName: string,
  rasterizeSvg: (content: Uint8Array) => Promise<Uint8Array> = async (content) => new Uint8Array(await sharp(Buffer.from(content)).png().toBuffer()),
) {
  const detectedType = mimeType(suggestedName);
  if (detectedType !== 'image/svg+xml') return { content: bytes, name: suggestedName, mimeType: detectedType };
  return {
    content: await rasterizeSvg(bytes),
    name: suggestedName.replace(/\.svg$/i, '.png'),
    mimeType: 'image/png',
  };
}

function noteBookName(groups: string[], section: string) {
  return [...groups, section].filter(Boolean).join(' / ') || 'Unfiled';
}

export async function importOneNoteBackup(options: {
  prisma: PrismaClient;
  userId: string;
  root: string;
  dryRun?: boolean;
  progress?: (message: string) => void;
}): Promise<OneNoteImportSummary> {
  const { prisma, userId, root, dryRun = false, progress = () => undefined } = options;
  const files = await discoverOneNoteBackups(root);
  const summary: OneNoteImportSummary = { files: files.length, sections: 0, pages: 0, imported: 0, skipped: 0, failed: 0, attachments: 0 };

  for (const file of files) {
    progress(`Reading ${file.relativePath}`);
    try {
      const data = new Uint8Array(await readFile(file.path));
      for (const entry of readSections(data, basename(file.path))) {
        summary.sections++;
        const section = entry.read();
        const notebookName = noteBookName([...file.groups, ...entry.groups], section.name || entry.title || file.sectionName);

        for (const page of section.pages) {
          if (page.isDeleted) continue;
          summary.pages++;
          if (await prisma.externalImport.findUnique({ where: { userId_provider_sourceId: { userId, provider: 'onenote', sourceId: page.id } } })) {
            summary.skipped++;
            continue;
          }
          if (dryRun) {
            try {
              await convertPage(page, {
                noteName: page.title,
                saveAttachment: async (_bytes, suggestedName) => {
                  summary.attachments++;
                  return { path: suggestedName, name: suggestedName };
                },
              });
              summary.imported++;
            } catch (error) {
              summary.failed++;
              progress(`Failed page ${page.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }

          const writtenMedia: Media[] = [];
          try {
            const converted = await convertPage(page, {
              noteName: page.title,
              resolveInternalLink: (_title, originalUrl) => originalUrl,
              saveAttachment: async (bytes, suggestedName) => {
                const normalized = await normalizeOneNoteAttachment(bytes, suggestedName);
                const media = await storeMedia(prisma, userId, normalized.content, normalized.name, normalized.mimeType, { thumbnail: normalized.mimeType.startsWith('image/') });
                writtenMedia.push(media);
                summary.attachments++;
                return { path: `/api/v1/media/${media.id}`, name: suggestedName };
              },
            });

            const note = await prisma.$transaction(async (transaction) => {
              const place = await transaction.place.upsert({
                where: { userId_name: { userId, name: file.placeName } },
                update: {},
                create: { userId, name: file.placeName },
              });
              const notebook = await transaction.notebook.upsert({
                where: { userId_placeId_name: { userId, placeId: place.id, name: notebookName } },
                update: {},
                create: { userId, placeId: place.id, name: notebookName },
              });
              const last = await transaction.note.findFirst({ where: { userId, notebookId: notebook.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
              const created = await transaction.note.create({
                data: {
                  userId,
                  notebookId: notebook.id,
                  title: page.title.trim() || 'Untitled note',
                  bodyMarkdown: converted.markdown,
                  sortOrder: (last?.sortOrder ?? -1) + 1,
                  ...(page.createdUtc ? { createdAt: page.createdUtc } : {}),
                  ...(page.lastModifiedUtc ? { updatedAt: page.lastModifiedUtc } : {}),
                },
              });
              await transaction.externalImport.create({ data: { userId, provider: 'onenote', sourceId: page.id, noteId: created.id } });
              return created;
            });
            try {
              const { replaceContextChunks } = await import('../context.js');
              await replaceContextChunks(prisma, userId, 'note', note.id, note.title, note.bodyMarkdown);
            } catch (error) {
              progress(`Imported page ${page.id}, but search indexing failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            summary.imported++;
          } catch (error) {
            for (const media of writtenMedia) await removeStoredMedia(prisma, media);
            summary.attachments -= writtenMedia.length;
            summary.failed++;
            progress(`Failed page ${page.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      summary.failed++;
      progress(`Failed file ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summary;
}
