/**
 * Shared configuration. Ids and hosts are defaults, each overridable by an
 * environment variable so a staging run never needs a code edit.
 *
 * No secret lives here. NOTION_TOKEN is read at call time in lib/notion.mjs.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** repo root = tools/testimonials/lib -> ../../.. */
export const REPO_ROOT = resolve(here, '..', '..', '..');

export const NOTION_DATABASE_ID = process.env.NOTION_TESTIMONIALS_DATABASE_ID ?? 'fe6d63c717f14c578c96d83028f8ecb2';
export const NOTION_DATA_SOURCE_ID = process.env.NOTION_TESTIMONIALS_DATA_SOURCE_ID ?? '96263e5afce34b03889e0d852e9a0266';

/** The durable public asset host: this repository, served by GitHub Pages. */
export const PUBLIC_BASE_URL = process.env.TESTIMONIALS_PUBLIC_BASE ?? 'https://media.jamesgunaca.com';

/**
 * Fallback used only to verify that a freshly committed asset is public, for
 * environments where the Pages custom domain is unreachable but GitHub is not.
 */
export const RAW_FALLBACK_BASE =
  process.env.TESTIMONIALS_RAW_BASE ?? 'https://raw.githubusercontent.com/Coach-James-Gunaca-Limited/James/main';

export const ASSET_SUBDIR = 'img/testimonials';
export const ASSET_DIR = resolve(REPO_ROOT, ASSET_SUBDIR);
export const assetPublicUrl = (filename) => `${PUBLIC_BASE_URL}/${ASSET_SUBDIR}/${filename}`;
export const assetRawUrl = (filename) => `${RAW_FALLBACK_BASE}/${ASSET_SUBDIR}/${filename}`;

export const FEED_SUBPATH = 'testimonials/approved.json';
export const FEED_PATH = resolve(REPO_ROOT, FEED_SUBPATH);
export const FEED_PUBLIC_URL = `${PUBLIC_BASE_URL}/${FEED_SUBPATH}`;

/**
 * Two manifests, because this repository is public.
 *
 * The full record carries Firebase `token=` credentials and Notion page ids, so
 * it is written to a git-ignored directory and never published. The redacted
 * copy is committed: enough to audit integrity and prove no testimonial.to URL
 * survives, with nothing sensitive in it.
 */
export const MANIFEST_PRIVATE_PATH = resolve(REPO_ROOT, '.migration/media-manifest.json');
export const MANIFEST_PUBLIC_PATH = resolve(REPO_ROOT, 'testimonials/media-manifest.json');
export const SCHEMA_PATH = resolve(here, '..', 'schema', 'approved-testimonials.schema.json');

export const FEED_SCHEMA_VERSION = 1;
