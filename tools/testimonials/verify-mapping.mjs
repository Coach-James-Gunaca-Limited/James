#!/usr/bin/env node
/**
 * Verify that every rescued asset maps to exactly one person, and produce a
 * visual proof sheet so a human can confirm each face is the person named
 * beside it.
 *
 * Filenames derive from the Migration Key, so the machine check proves the
 * mapping is internally consistent. It cannot prove that testimonial.to's own
 * export attached the right photo to the right person in the first place: only
 * looking at the sheet can do that.
 *
 * The sheet pairs real names with real faces, so it is written to the
 * git-ignored .migration/ directory and must never be committed to this public
 * repository.
 *
 * Usage:
 *   NOTION_TOKEN=... node tools/testimonials/verify-mapping.mjs
 */

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { queryAllRows } from './lib/notion.mjs';
import { normaliseRow, publicId } from './lib/rows.mjs';
import { NOTION_DATA_SOURCE_ID, ASSET_DIR, REPO_ROOT } from './lib/config.mjs';

const OUT = resolve(REPO_ROOT, '.migration/mapping-proof.html');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = (await queryAllRows(NOTION_DATA_SOURCE_ID, { log: console.log })).map(normaliseRow);
const files = new Set(await readdir(ASSET_DIR));

const expected = [];
for (const row of rows) {
  if (!row.migrationKey) continue;
  const id = publicId(row.migrationKey);
  for (const [url, kind] of [[row.avatarUrl, 'avatar'], [row.attachedImageUrl, 'attached']]) {
    if (!url) continue;
    const file = [...files].find((f) => f.startsWith(`${id}-${kind}.`)) ?? null;
    expected.push({ name: row.name, kind, file, id });
  }
}

const missing = expected.filter((e) => !e.file);
const claimed = new Set(expected.map((e) => e.file).filter(Boolean));
const orphans = [...files].filter((f) => !claimed.has(f));
const shared = expected.filter((e) => e.file).length - claimed.size;

console.log(`\nrows read:                ${rows.length}`);
console.log(`assets expected:          ${expected.length}`);
console.log(`files on disk:            ${files.size}`);
console.log(`unresolved (no file):     ${missing.length}`);
console.log(`orphans (no owner):       ${orphans.length}`);
console.log(`files shared by >1 row:   ${shared}`);
if (missing.length) console.log('\nUNRESOLVED:\n' + missing.map((m) => `  ${m.name} [${m.kind}]`).join('\n'));
if (orphans.length) console.log('\nORPHANS:\n' + orphans.map((f) => `  ${f}`).join('\n'));

// Two rows can legitimately share a display name; flag them so a human looks.
const duplicateNames = new Set(
  rows.filter((r) => r.name && rows.filter((o) => o.name === r.name).length > 1).map((r) => r.name),
);
if (duplicateNames.size) {
  console.log('\nDUPLICATE NAMES (distinct rows - confirm they are distinct people):');
  for (const name of duplicateNames) console.log(`  ${name}`);
}

const cell = (e) => `<figure><img src="../img/testimonials/${esc(e.file)}" alt=""><figcaption><b>${esc(e.name ?? 'Untitled')}</b><span>${esc(e.file ?? 'MISSING')}</span></figcaption></figure>`;
const avatars = expected.filter((e) => e.kind === 'avatar' && e.file);
const shots = expected.filter((e) => e.kind === 'attached' && e.file);

await mkdir(resolve(REPO_ROOT, '.migration'), { recursive: true });
await writeFile(OUT, `<!doctype html><meta charset="utf-8">
<title>Rescued media - name mapping proof</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;color:#2B2D35;background:#F6F8FC;margin:0;padding:24px 28px}
 h1{font-size:1.15rem;margin:0 0 4px} p.sub{margin:0 0 20px;color:#6B7280}
 h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.07em;color:#6B7280;margin:26px 0 12px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
 figure{margin:0;background:#fff;border:1px solid #E8ECF3;border-radius:10px;padding:12px;display:flex;gap:11px;align-items:center}
 figure img{width:52px;height:52px;border-radius:50%;object-fit:cover;background:#E8ECF3;flex:0 0 52px}
 .shots figure{display:block} .shots img{width:100%;height:auto;border-radius:6px;margin-bottom:8px}
 figcaption{min-width:0;font-size:.82rem} figcaption b{display:block;font-size:.9rem}
 figcaption span{color:#6B7280;font-size:.68rem;word-break:break-all}
</style>
<h1>Rescued testimonial media - name mapping proof</h1>
<p class="sub">${avatars.length} avatars and ${shots.length} attached images, each matched to its Notion row by Migration Key. Check that each face is the person named beside it. Not for committing: real names and faces.</p>
<h2>Avatars (${avatars.length})</h2><div class="grid">${avatars.map(cell).join('')}</div>
<h2>Attached images (${shots.length})</h2><div class="grid shots">${shots.map(cell).join('')}</div>`);

console.log(`\nProof sheet: ${OUT}`);
console.log('Open it and check each face against its name.');

if (missing.length || orphans.length || shared > 0) process.exitCode = 1;
