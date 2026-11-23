import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverOneNoteBackups, normalizeOneNoteAttachment } from '../src/onenote/import.js';
import { convertPage } from '../src/onenote/onefile/convert.js';
import { readSections } from '../src/onenote/onefile/package.js';

test('keeps only the newest dated backup for each section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notes-onenote-'));
  try {
    const older = join(root, 'Notebook', 'Section (On 1-1-2026).one');
    const newer = join(root, 'Notebook', 'Section (On 2-1-2026).one');
    await mkdir(dirname(older), { recursive: true });
    await writeFile(older, 'older');
    await writeFile(newer, 'newer');
    await utimes(older, new Date('2026-01-01'), new Date('2026-01-01'));
    await utimes(newer, new Date('2026-02-01'), new Date('2026-02-01'));

    const files = await discoverOneNoteBackups(root);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, newer);
    assert.equal(files[0].placeName, 'Notebook');
    assert.equal(files[0].sectionName, 'Section');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('converts a real OneNote section with embedded images', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/onenote/testOneNote.one', import.meta.url));
  const sections = readSections(new Uint8Array(await readFile(fixture)), 'testOneNote.one');
  assert.equal(sections.length, 1);

  const pages = sections[0].read().pages.filter((page) => !page.isDeleted);
  assert.ok(pages.length > 0);
  let attachmentCount = 0;
  for (const page of pages) {
    const converted = await convertPage(page, {
      saveAttachment: async (_bytes, name) => {
        attachmentCount++;
        return { path: `attachments/${name}`, name };
      },
    });
    assert.ok(converted.markdown.length > 0);
  }
  assert.ok(attachmentCount > 0);
});

test('rasterizes imported SVG before it reaches authenticated media storage', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  let rasterized = false;
  const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const normalized = await normalizeOneNoteAttachment(svg, 'Ink.svg', async () => {
    rasterized = true;
    return pngHeader;
  });
  assert.equal(rasterized, true);
  assert.equal(normalized.name, 'Ink.png');
  assert.equal(normalized.mimeType, 'image/png');
  assert.deepEqual(normalized.content, pngHeader);
});
