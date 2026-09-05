#!/usr/bin/env node
/**
 * Phase 2 — rescue testimonial.to media onto media.jamesgunaca.com.
 *
 * Idempotent by construction:
 *   - filenames are derived from the Migration Key and asset type, so a rerun
 *     rewrites the same path instead of creating a duplicate;
 *   - a row whose Notion URL already points at our own host is skipped;
 *   - an asset already on disk with a matching checksum is not re-downloaded.
 *
 * Ordering is deliberate and must not be rearranged: download -> validate ->
 * write to disk -> (operator commits) -> verify the public URL responds ->
 * only then patch Notion. The original testimonial.to URL is never overwritten
 * until its replacement has been proven reachable.
 *
 * Usage:
 *   node tools/testimonials/migrate-media.mjs --dry-run
 *   node tools/testimonials/migrate-media.mjs --download        # fetch + write files, no Notion writes
 *   node tools/testimonials/migrate-media.mjs --apply           # verify public URLs + patch Notion
 *   node tools/testimonials/migrate-media.mjs --dry-run --rows-file rows.json
 *
 * Flags:
 *   --dry-run          report only; touches nothing
 *   --download         download and write assets + manifest; no Notion writes
 *   --apply            full run: download, write, verify public URLs, patch Notion
 *   --rows-file PATH   read normalised rows from a JSON file instead of Notion
 *                      (offline replay, for dry runs where api.notion.com is
 *                      unreachable; see README)
 *   --limit N          process at most N assets (smoke tests)
 *   --force            re-download even when an identical file already exists
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { queryAllRows, updatePageProperties } from './lib/notion.mjs';
import { normaliseRow, PROP, publicId } from './lib/rows.mjs';
import {
  isLegacyMediaUrl,
  isRehostedUrl,
  assetFilename,
  downloadAsset,
  verifyPublicUrl,
  sha256,
  AssetError,
} from './lib/assets.mjs';
import { writeJsonAtomic } from './lib/atomic.mjs';
import {
  NOTION_DATA_SOURCE_ID,
  ASSET_DIR,
  ASSET_SUBDIR,
  MANIFEST_PRIVATE_PATH,
  MANIFEST_PUBLIC_PATH,
  PUBLIC_BASE_URL,
  assetPublicUrl,
  assetRawUrl,
} from './lib/config.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const MODE = has('--apply') ? 'apply' : has('--download') ? 'download' : 'dry-run';
const ROWS_FILE = valueOf('--rows-file');
const LIMIT = Number(valueOf('--limit') ?? Infinity);
const FORCE = has('--force');

const log = (message) => console.log(message);
const warn = (message) => console.warn(message);

/** The two URL properties that can hold legacy media. */
const ASSET_SLOTS = [
  { kind: 'avatar', field: 'avatarUrl', property: PROP.avatarUrl },
  { kind: 'attached', field: 'attachedImageUrl', property: PROP.attachedImages },
];

async function loadRows() {
  if (ROWS_FILE) {
    const raw = JSON.parse(await readFile(resolve(ROWS_FILE), 'utf8'));
    log(`Loaded ${raw.length} normalised rows from ${ROWS_FILE} (offline replay).`);
    return raw;
  }
  log(`Querying Notion data source ${NOTION_DATA_SOURCE_ID}...`);
  const pages = await queryAllRows(NOTION_DATA_SOURCE_ID, { log });
  log(`Fetched ${pages.length} rows from Notion.`);
  return pages.map(normaliseRow);
}

/** Every legacy asset across every row, in a stable order. */
function discoverAssets(rows) {
  const found = [];
  for (const row of rows) {
    for (const slot of ASSET_SLOTS) {
      const url = row[slot.field];
      if (!url) continue;
      if (isRehostedUrl(url, PUBLIC_BASE_URL)) {
        found.push({ ...slot, row, url, state: 'already-rehosted' });
        continue;
      }
      if (!isLegacyMediaUrl(url)) {
        found.push({ ...slot, row, url, state: 'foreign-host' });
        continue;
      }
      found.push({ ...slot, row, url, state: 'pending' });
    }
  }
  return found.sort((a, b) =>
    `${a.row.migrationKey}${a.kind}` < `${b.row.migrationKey}${b.kind}` ? -1 : 1,
  );
}

/** Reuse an identical file already on disk so reruns are cheap and stable. */
async function existingAsset(filename, checksum) {
  const path = resolve(ASSET_DIR, filename);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    const existing = await readFile(path);
    return sha256(existing) === checksum ? { path, bytes: info.size } : null;
  } catch {
    return null;
  }
}

/**
 * Strip everything from a manifest entry that must not appear in a public repo:
 * the Notion page id, the Migration Key, and the query string of the original
 * URL (which carries the Firebase download token). The bucket path is kept so
 * provenance is still auditable.
 */
function redactAsset(entry) {
  let originalUrl = null;
  if (entry.originalUrl) {
    try {
      const url = new URL(entry.originalUrl);
      url.search = '';
      originalUrl = url.toString();
    } catch {
      originalUrl = null;
    }
  }
  return {
    id: entry.migrationKey ? publicId(entry.migrationKey) : null,
    assetType: entry.assetType,
    originalUrlRedacted: originalUrl,
    newUrl: entry.newUrl,
    checksum: entry.checksum,
    bytes: entry.bytes,
    status: entry.status,
  };
}

async function main() {
  log(`\n=== testimonial media migration — mode: ${MODE} ===\n`);

  const rows = await loadRows();
  const assets = discoverAssets(rows);

  const pending = assets.filter((a) => a.state === 'pending');
  const alreadyRehosted = assets.filter((a) => a.state === 'already-rehosted');
  const foreign = assets.filter((a) => a.state === 'foreign-host');

  log(`Rows:                 ${rows.length}`);
  log(`Assets discovered:    ${assets.length}`);
  log(`  legacy (to rescue): ${pending.length}`);
  log(`  already rehosted:   ${alreadyRehosted.length}`);
  log(`  other hosts:        ${foreign.length}`);
  log(`  avatars / attached: ${pending.filter((a) => a.kind === 'avatar').length} / ${pending.filter((a) => a.kind === 'attached').length}\n`);

  const manifest = [];
  const counts = { discovered: assets.length, downloaded: 0, uploaded: 0, verified: 0, notionUpdated: 0, skipped: alreadyRehosted.length + foreign.length, failed: 0 };

  for (const entry of [...alreadyRehosted, ...foreign]) {
    manifest.push({
      notionPageId: entry.row.pageId,
      migrationKey: entry.row.migrationKey,
      assetType: entry.kind,
      originalUrl: entry.url,
      newUrl: entry.state === 'already-rehosted' ? entry.url : null,
      checksum: null,
      bytes: null,
      status: entry.state === 'already-rehosted' ? 'skipped-already-migrated' : 'skipped-foreign-host',
    });
  }

  let processed = 0;
  if (MODE !== 'dry-run') await mkdir(ASSET_DIR, { recursive: true });

  for (const entry of pending) {
    if (processed >= LIMIT) break;
    processed += 1;

    const { row, kind, url } = entry;
    const label = `${row.migrationKey} [${kind}]`;

    if (MODE === 'dry-run') {
      log(`  WOULD FETCH ${label}\n              ${url}`);
      manifest.push({
        notionPageId: row.pageId,
        migrationKey: row.migrationKey,
        assetType: kind,
        originalUrl: url,
        newUrl: null,
        checksum: null,
        bytes: null,
        status: 'dry-run',
      });
      continue;
    }

    let asset;
    try {
      asset = await downloadAsset(url, { log });
      counts.downloaded += 1;
    } catch (error) {
      // A single bad asset must never abandon the remaining valid downloads.
      counts.failed += 1;
      warn(`  FAILED  ${label}: ${error.message}`);
      manifest.push({
        notionPageId: row.pageId,
        migrationKey: row.migrationKey,
        assetType: kind,
        originalUrl: url,
        newUrl: null,
        checksum: null,
        bytes: null,
        status: 'failed-download',
        error: error.message,
      });
      continue;
    }

    const filename = assetFilename(row.migrationKey, kind, asset.ext);
    const destination = resolve(ASSET_DIR, filename);
    const newUrl = assetPublicUrl(filename);

    const reusable = FORCE ? null : await existingAsset(filename, asset.checksum);
    if (reusable) {
      log(`  UNCHANGED ${label} -> ${ASSET_SUBDIR}/${filename} (${asset.bytes} B)`);
    } else {
      await writeFile(destination, asset.buffer);
      counts.uploaded += 1;
      log(`  SAVED   ${label} -> ${ASSET_SUBDIR}/${filename} (${asset.bytes} B, ${asset.ext})`);
    }

    const record = {
      notionPageId: row.pageId,
      migrationKey: row.migrationKey,
      assetType: kind,
      originalUrl: url,
      newUrl,
      checksum: asset.checksum,
      bytes: asset.bytes,
      contentType: asset.contentType,
      localPath: `${ASSET_SUBDIR}/${filename}`,
      status: 'downloaded',
    };

    if (MODE === 'download') {
      record.status = 'downloaded-pending-publish';
      manifest.push(record);
      continue;
    }

    // --apply: prove the replacement is live before repointing Notion at it.
    let verification = await verifyPublicUrl(newUrl);
    if (!verification.ok) {
      const fallback = await verifyPublicUrl(assetRawUrl(filename));
      if (fallback.ok) verification = { ...fallback, via: 'raw.githubusercontent.com' };
    }

    if (!verification.ok) {
      counts.failed += 1;
      record.status = 'failed-verification';
      record.error = `replacement URL not reachable (${verification.status ?? 'no response'}: ${verification.detail ?? 'unknown'})`;
      warn(`  UNVERIFIED ${label}: ${record.error} — Notion left pointing at the original URL.`);
      manifest.push(record);
      continue;
    }

    counts.verified += 1;
    record.verifiedVia = verification.via;

    try {
      await updatePageProperties(row.pageId, { [entry.property]: { url: newUrl } }, { log });
      counts.notionUpdated += 1;
      record.status = 'migrated';
      log(`  NOTION  ${label} -> ${newUrl}`);
    } catch (error) {
      counts.failed += 1;
      record.status = 'failed-notion-update';
      record.error = error.message;
      warn(`  NOTION FAILED ${label}: ${error.message} — asset is safe on disk, rerun to retry.`);
    }
    manifest.push(record);
  }

  manifest.sort((a, b) => `${a.migrationKey}${a.assetType}` < `${b.migrationKey}${b.assetType}` ? -1 : 1);

  const meta = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    publicBaseUrl: PUBLIC_BASE_URL,
    counts,
  };

  if (MODE === 'dry-run') {
    log(`\n(dry run — manifests not written)`);
  } else {
    // Full record: the rollback source. Git-ignored, because the original
    // Firebase URLs embed download tokens and this repository is public.
    await writeJsonAtomic(MANIFEST_PRIVATE_PATH, { meta, assets: manifest });
    log(`\nRollback manifest (private, git-ignored): ${MANIFEST_PRIVATE_PATH}`);

    // Committed copy: provenance and integrity, with credentials stripped.
    await writeJsonAtomic(MANIFEST_PUBLIC_PATH, { meta, assets: manifest.map(redactAsset) });
    log(`Public manifest:                          ${MANIFEST_PUBLIC_PATH}`);
  }

  log(`\n--- summary (${MODE}) ---`);
  for (const [key, value] of Object.entries(counts)) log(`  ${key.padEnd(14)} ${value}`);

  const remaining = manifest.filter((m) => m.status !== 'migrated' && m.status.startsWith('failed')).length;
  if (remaining > 0) {
    warn(`\n${remaining} asset(s) failed. Rerun the same command: completed work is skipped.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nFATAL: ${error.message}`);
  if (error instanceof AssetError && error.url) console.error(`  url: ${error.url}`);
  process.exitCode = 1;
});
