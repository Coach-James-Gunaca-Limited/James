/**
 * Minimal, dependency-free Notion client for the Testimonials workflow.
 *
 * Uses the 2025-09-03 data-source endpoints (data_sources/{id}/query), handles
 * pagination, client-side throttling, and retries with exponential backoff.
 *
 * The integration token is read from NOTION_TOKEN. It is never logged, printed,
 * written to a manifest, or included in an error message.
 */

const NOTION_VERSION = '2025-09-03';
const API_BASE = 'https://api.notion.com/v1';

/** Notion's published limit is an average of 3 requests/second. */
const MIN_REQUEST_INTERVAL_MS = 340;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class NotionError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function readToken() {
  const token = process.env.NOTION_TOKEN;
  if (!token || !token.trim()) {
    throw new NotionError(
      'NOTION_TOKEN is not set. Export the Notion integration token before running ' +
        'this script (see tools/testimonials/README.md).',
    );
  }
  return token.trim();
}

/**
 * Strip anything that looks like a bearer token out of text before it reaches a
 * log line. Defence in depth: Notion does not echo credentials, but a proxy or
 * a future code path might.
 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b(ntn|secret)_[A-Za-z0-9]{8,}/g, '$1_***REDACTED***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***REDACTED***');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextRequestAt = 0;

async function throttle() {
  const now = Date.now();
  if (now < nextRequestAt) await sleep(nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
}

/** Full jitter backoff, capped, so parallel reruns do not resonate. */
function backoffMs(attempt) {
  return Math.round(Math.random() * Math.min(30_000, 500 * 2 ** attempt));
}

/**
 * Perform a single Notion API request with throttling and retries.
 *
 * @param {string} path      Path below /v1, e.g. `/pages/abc`.
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @param {number} [options.maxAttempts]
 * @param {(msg: string) => void} [options.log]
 */
export async function notionRequest(path, { method = 'GET', body, maxAttempts = 6, log } = {}) {
  const url = `${API_BASE}${path}`;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await throttle();

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${readToken()}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // Network-level failure (DNS, TLS, socket reset). Always worth a retry.
      lastError = new NotionError(`Network failure calling ${method} ${path}: ${redact(cause.message)}`);
      if (attempt === maxAttempts - 1) break;
      const wait = backoffMs(attempt);
      log?.(`  network error on ${method} ${path}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }

    if (response.ok) return response.json();

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const raw = await response.text();
    let code;
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      code = parsed.code;
      message = parsed.message ?? raw;
    } catch {
      /* non-JSON error body; keep the raw text */
    }

    lastError = new NotionError(
      `Notion ${method} ${path} failed with ${response.status}: ${redact(message)}`,
      { status: response.status, code, requestId },
    );

    if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) break;

    // Honour Retry-After when Notion sends it, otherwise back off exponentially.
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
    log?.(`  ${response.status} on ${method} ${path}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
    await sleep(wait);
  }

  throw lastError;
}

/**
 * Query every page of a data source, following `next_cursor` until exhausted.
 *
 * @param {string} dataSourceId
 * @param {object} [options]
 * @param {object} [options.filter]
 * @param {object[]} [options.sorts]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<object[]>} Every result page object.
 */
export async function queryAllRows(dataSourceId, { filter, sorts, log } = {}) {
  const rows = [];
  let cursor;
  let page = 0;

  do {
    page += 1;
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const data = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body,
      log,
    });

    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
    log?.(`  fetched page ${page} (${data.results.length} rows, ${rows.length} total)`);
  } while (cursor);

  return rows;
}

/**
 * Patch a page's properties. Used only to swap a rescued asset URL in, and only
 * after the replacement has been verified reachable.
 */
export async function updatePageProperties(pageId, properties, { log } = {}) {
  return notionRequest(`/pages/${pageId}`, { method: 'PATCH', body: { properties }, log });
}

export const __testing = { backoffMs, NOTION_VERSION, MIN_REQUEST_INTERVAL_MS };
