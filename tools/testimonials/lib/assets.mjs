/**
 * Discovery, download, validation and deterministic naming of testimonial media.
 *
 * The migration is a rescue: testimonial.to's Firebase bucket disappears when the
 * subscription is cancelled, so every download is validated hard (status,
 * content type, non-zero length, and magic bytes) before anything downstream
 * treats the file as real.
 */

import { createHash } from 'node:crypto';
import { publicId } from './rows.mjs';

/** Hosts that serve the legacy, soon-to-vanish testimonial.to media. */
const LEGACY_HOST_PATTERNS = [
  /(^|\.)testimonial\.to$/i,
  /(^|\.)firebasestorage\.googleapis\.com$/i,
  /(^|\.)testimonialto\.appspot\.com$/i,
  /(^|\.)testimonialto\.s3[.-][a-z0-9-]*\.?amazonaws\.com$/i,
];

/**
 * Image signatures, checked against the first bytes of every download. Trusting
 * Content-Type alone would let an HTML error page through with a 200.
 */
const SIGNATURES = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 },
  { ext: 'gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  {
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    ext: 'avif',
    test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /avif|avis/.test(b.subarray(8, 12).toString('latin1')),
  },
  {
    ext: 'heic',
    test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /heic|heix|mif1/.test(b.subarray(8, 12).toString('latin1')),
  },
];

export class AssetError extends Error {
  constructor(message, { url, stage } = {}) {
    super(message);
    this.name = 'AssetError';
    this.url = url;
    this.stage = stage;
  }
}

/** True when the URL points at media that will die with the subscription. */
export function isLegacyMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (LEGACY_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) return true;
  // The Firebase download URL embeds the bucket in the path as well as the host.
  return url.pathname.includes('testimonialto.appspot.com');
}

/** True when the URL already points at our own durable host. */
export function isRehostedUrl(value, publicBaseUrl) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return new URL(value).origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Deterministic filename from the Migration Key and asset type, so a rerun
 * overwrites the same path instead of accumulating duplicates.
 */
export function assetFilename(migrationKey, kind, ext) {
  if (kind !== 'avatar' && kind !== 'attached') {
    throw new AssetError(`Unknown asset kind "${kind}"`);
  }
  return `${publicId(migrationKey)}-${kind}.${ext}`;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Identify the real format from the bytes; returns null if it is not an image. */
export function detectImageExtension(buffer) {
  if (buffer.length < 12) return null;
  for (const { ext, test } of SIGNATURES) {
    try {
      if (test(buffer)) return ext;
    } catch {
      /* signature probe ran off the end of a short buffer */
    }
  }
  // SVG is text; accept it only when it really parses as an <svg> root.
  const head = buffer.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download one asset and prove it is a real, non-empty image.
 *
 * @returns {Promise<{ buffer: Buffer, ext: string, contentType: string, bytes: number, checksum: string }>}
 * @throws {AssetError} on any validation failure, so callers can record the row
 *         as failed and carry on with the rest of the batch.
 */
export async function downloadAsset(url, { timeoutMs = 45_000, maxAttempts = 4, log } = {}) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new AssetError(`HTTP ${response.status} ${response.statusText}`, { url, stage: 'http' });
        if (!retryable || attempt === maxAttempts - 1) throw lastError;
        const wait = Math.round(Math.random() * 500 * 2 ** attempt);
        log?.(`    HTTP ${response.status}, retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length === 0) {
        throw new AssetError('downloaded 0 bytes', { url, stage: 'size' });
      }
      if (contentType && !contentType.startsWith('image/')) {
        throw new AssetError(`unexpected content type "${contentType}"`, { url, stage: 'content-type' });
      }

      const ext = detectImageExtension(buffer);
      if (!ext) {
        throw new AssetError(
          `content did not match any known image signature (${buffer.length} bytes, content-type "${contentType || 'none'}")`,
          { url, stage: 'integrity' },
        );
      }

      return { buffer, ext, contentType: contentType || `image/${ext}`, bytes: buffer.length, checksum: sha256(buffer) };
    } catch (error) {
      if (error instanceof AssetError && error.stage !== 'http') throw error; // validation failure: no retry
      lastError = error instanceof AssetError ? error : new AssetError(`network failure: ${error.message}`, { url, stage: 'network' });
      if (attempt === maxAttempts - 1) throw lastError;
      const wait = Math.round(Math.random() * 500 * 2 ** attempt);
      log?.(`    ${lastError.message}, retrying in ${wait}ms`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new AssetError('download failed', { url });
}

/**
 * Confirm a rehosted asset is actually being served before Notion is repointed
 * at it. Returns a result rather than throwing so the caller can decide whether
 * an unreachable-but-committed asset should still block the Notion write.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, via: string, detail?: string }>}
 */
export async function verifyPublicUrl(url, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Range-limited GET rather than HEAD: some CDNs answer HEAD from a colder
    // path, and a couple of bytes is enough to prove the object is served.
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Range: 'bytes=0-63' },
    });
    const ok = response.status === 200 || response.status === 206;
    return { ok, status: response.status, via: 'http', detail: ok ? undefined : response.statusText };
  } catch (error) {
    return { ok: false, status: null, via: 'http', detail: error.message };
  } finally {
    clearTimeout(timer);
  }
}
