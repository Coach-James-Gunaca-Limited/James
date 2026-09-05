#!/usr/bin/env node
/**
 * Phase 3 — publish the approved-testimonials JSON feed.
 *
 * Publishes only rows where Status = "Approved for Use" AND Consent to Publish
 * is checked. Consent alone is never enough: moderation state decides.
 *
 * The payload is built from an explicit allowlist (lib/rows.mjs), validated
 * against schema/approved-testimonials.schema.json, and written atomically so a
 * failed run cannot leave a truncated feed for the CDN to serve.
 *
 * Usage:
 *   node tools/testimonials/publish-json.mjs
 *   node tools/testimonials/publish-json.mjs --dry-run
 *   node tools/testimonials/publish-json.mjs --rows-file rows.json --out /tmp/feed.json
 *
 * Flags:
 *   --dry-run        build and validate, print a summary, write nothing
 *   --rows-file PATH read normalised rows from JSON instead of querying Notion
 *   --out PATH       write somewhere other than testimonials/approved.json
 *   --allow-legacy   do not fail when a published URL still points at testimonial.to
 *   --rewrite-legacy-media
 *                    swap any remaining testimonial.to URL for its rescued
 *                    equivalent on media.jamesgunaca.com, using the migration
 *                    manifest
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { queryAllRows } from './lib/notion.mjs';
import { normaliseRow, isPublishable, toPublicRecord, sortPublicRecords, PUBLIC_FIELDS } from './lib/rows.mjs';
import { isLegacyMediaUrl } from './lib/assets.mjs';
import { assertValid } from './lib/validate.mjs';
import { writeJsonAtomic } from './lib/atomic.mjs';
import { NOTION_DATA_SOURCE_ID, FEED_PATH, FEED_PUBLIC_URL, SCHEMA_PATH, FEED_SCHEMA_VERSION, MANIFEST_PUBLIC_PATH } from './lib/config.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const DRY_RUN = has('--dry-run');
const ROWS_FILE = valueOf('--rows-file');
const OUT_PATH = valueOf('--out') ? resolve(valueOf('--out')) : FEED_PATH;
const ALLOW_LEGACY = has('--allow-legacy');
const REWRITE_LEGACY = has('--rewrite-legacy-media');

const log = (message) => console.log(message);

/**
 * Assemble the feed document from normalised rows. Exported so the tests can
 * exercise filtering, ordering and leakage without touching the network.
 */
export function buildFeed(rows, { generatedAt = new Date().toISOString(), mediaMap } = {}) {
  const publishable = rows.filter(isPublishable);
  let testimonials = sortPublicRecords(publishable.map(toPublicRecord));

  if (mediaMap) testimonials = testimonials.map((record) => rewriteMedia(record, mediaMap));

  return {
    // Build metadata is deliberately separate from the records themselves, so a
    // consumer can cache on `meta` without it polluting testimonial objects.
    meta: {
      schemaVersion: FEED_SCHEMA_VERSION,
      generatedAt,
      count: testimonials.length,
      source: 'Notion — Testimonials',
    },
    testimonials,
  };
}

/**
 * Swap a legacy testimonial.to URL for the rescued copy on our own host.
 *
 * The feed should serve durable URLs whether or not the Notion write-back has
 * run yet, and the mapping is exact: the rescued filename is derived from the
 * same Migration Key that produced the record's id, so `<id>-avatar` and
 * `<id>-attached` identify the asset unambiguously. Once migrate-media.mjs
 * --apply has repointed Notion, this becomes a no-op.
 *
 * A legacy URL with no manifest entry throws rather than being dropped or
 * published as-is: silently losing someone's photo is worse than a failed run.
 */
function rewriteMedia(record, mediaMap) {
  const swap = (url, kind) => {
    if (!isLegacyMediaUrl(url)) return url;
    const replacement = mediaMap.get(`${record.id}-${kind}`);
    if (!replacement) {
      throw new Error(
        `${record.id} has a legacy ${kind} URL with no entry in the migration manifest. ` +
          'Run migrate-media.mjs --download first so the asset exists.',
      );
    }
    return replacement;
  };
  return { ...record, avatarUrl: swap(record.avatarUrl, 'avatar'), attachedImageUrl: swap(record.attachedImageUrl, 'attached') };
}

/** Build the id+kind -> durable URL lookup from the committed manifest. */
async function loadMediaMap() {
  const manifest = JSON.parse(await readFile(MANIFEST_PUBLIC_PATH, 'utf8'));
  const map = new Map();
  for (const asset of manifest.assets ?? []) {
    if (asset.id && asset.newUrl) map.set(`${asset.id}-${asset.assetType}`, asset.newUrl);
  }
  return map;
}

async function loadRows() {
  if (ROWS_FILE) {
    const rows = JSON.parse(await readFile(resolve(ROWS_FILE), 'utf8'));
    log(`Loaded ${rows.length} normalised rows from ${ROWS_FILE} (offline replay).`);
    return rows;
  }
  log(`Querying Notion data source ${NOTION_DATA_SOURCE_ID}...`);
  const pages = await queryAllRows(NOTION_DATA_SOURCE_ID, { log });
  log(`Fetched ${pages.length} rows from Notion.`);
  return pages.map(normaliseRow);
}

/** Belt and braces: prove no private key survived, whatever the schema said. */
function assertNoPrivateFields(feed) {
  const allowed = new Set(PUBLIC_FIELDS);
  for (const record of feed.testimonials) {
    const extra = Object.keys(record).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      throw new Error(`Record ${record.id} carries non-public field(s): ${extra.join(', ')}`);
    }
  }
}

async function main() {
  const rows = await loadRows();

  let mediaMap;
  if (REWRITE_LEGACY) {
    mediaMap = await loadMediaMap();
    log(`Loaded ${mediaMap.size} rescued asset(s) from the migration manifest.`);
  }

  const feed = buildFeed(rows, { mediaMap });

  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  assertValid(feed, schema, 'approved testimonials feed');
  assertNoPrivateFields(feed);

  const approved = rows.filter((r) => r.status === 'Approved for Use').length;
  const consented = rows.filter((r) => r.consentToPublish === true).length;

  log(`\nRows read:              ${rows.length}`);
  log(`  Approved for Use:     ${approved}`);
  log(`  Consent to Publish:   ${consented}`);
  log(`  published (both):     ${feed.meta.count}`);
  log(`  featured:             ${feed.testimonials.filter((t) => t.featured).length}`);
  log(`  with avatar:          ${feed.testimonials.filter((t) => t.avatarUrl).length}`);
  log(`  with attached image:  ${feed.testimonials.filter((t) => t.attachedImageUrl).length}`);

  const legacy = feed.testimonials.filter(
    (t) => isLegacyMediaUrl(t.avatarUrl) || isLegacyMediaUrl(t.attachedImageUrl),
  );
  if (legacy.length > 0) {
    const message =
      `${legacy.length} published record(s) still point at testimonial.to media. ` +
      `Pass --rewrite-legacy-media to serve the rescued copies instead, run ` +
      `migrate-media.mjs --apply to fix Notion itself, or pass --allow-legacy to publish anyway.`;
    if (!ALLOW_LEGACY) throw new Error(message);
    console.warn(`\nWARNING: ${message}`);
  }

  if (feed.meta.count === 0) {
    console.warn(
      '\nNOTE: no rows are both "Approved for Use" and consented, so the feed is empty. ' +
        'The widget will render its empty state. This is expected until moderation has run.',
    );
  }

  if (DRY_RUN) {
    log(`\n(dry run — nothing written; would write ${OUT_PATH})`);
    return;
  }

  await writeJsonAtomic(OUT_PATH, feed);
  log(`\nFeed written: ${OUT_PATH}`);
  if (OUT_PATH === FEED_PATH) log(`Public URL after push: ${FEED_PUBLIC_URL}`);
}

// Only run when invoked directly, so the tests can import buildFeed.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nFATAL: ${error.message}`);
    process.exitCode = 1;
  });
}
