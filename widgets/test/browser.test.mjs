/**
 * Browser checks for the Wall of Love widget.
 *
 * Drives the real widgets/wall-of-love.html through widgets/preview.html in
 * headless Chromium and asserts the behaviour that unit tests cannot reach:
 * rendering, Load more, keyboard operation, the empty and failed-network
 * states, mobile layout, CSS containment, and injection safety.
 *
 * Run:
 *   npx --yes http-server . -p 8099 --silent &
 *   node widgets/test/browser.test.mjs
 *
 * Optional: JG_WOL_PORT to change the port, JG_WOL_SHOTS=<dir> to save
 * screenshots.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

/**
 * Playwright is a developer tool, not a dependency of this static site, so it is
 * resolved from wherever it happens to be installed (local, or a global npm
 * prefix) instead of being added to package.json.
 */
function loadPlaywright() {
  const require_ = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(require_.resolve('playwright')); } catch { /* not local */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(`${globalRoot}/playwright/index.js`);
  } catch { /* npm unavailable */ }
  for (const path of candidates) {
    try { return require_(path); } catch { /* try the next one */ }
  }
  throw new Error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium');
}

const { chromium } = loadPlaywright();

const PORT = process.env.JG_WOL_PORT || '8099';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/widgets/preview.html`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();

async function newPage(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const dialogs = [];
  const errors = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, context, dialogs, errors };
}

const SHOT_DIR = process.env.JG_WOL_SHOTS || '';
const shot = (name) => (SHOT_DIR ? `${SHOT_DIR}/shot-${name}.png` : undefined);

/* ---------------------------------------------------- desktop: full wall */
{
  const { page, context, dialogs, errors } = await newPage({ width: 1280, height: 1000 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.jg-wol__card', { timeout: 10000 });

  // Counts come from the fixture so adding a record cannot silently break these.
  const fixture = await (await fetch(`${ORIGIN}/widgets/fixtures/preview-feed.json`)).json();
  const TOTAL = fixture.testimonials.length;

  const initial = await page.locator('.jg-wol__card').count();
  check('desktop: renders exactly initialCount (24) cards', initial === 24, `got ${initial}`);

  const loadMore = page.locator('.jg-wol__btn', { hasText: 'Load more' });
  check(`desktop: Load more is visible with ${TOTAL} records`, await loadMore.isVisible());

  await loadMore.click();
  await page.waitForTimeout(300);
  const after = await page.locator('.jg-wol__card').count();
  check(`desktop: Load more reveals the rest (${TOTAL})`, after === TOTAL, `got ${after}, expected ${TOTAL}`);
  check('desktop: Load more hides when all are visible', !(await loadMore.isVisible().catch(() => false)));

  // Fetched exactly once: Load more must come from memory.
  const feedRequests = [];
  page.on('request', (r) => { if (r.url().includes('preview-feed.json')) feedRequests.push(r.url()); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.jg-wol__card');
  await page.locator('.jg-wol__btn', { hasText: 'Load more' }).click();
  await page.waitForTimeout(300);
  check('desktop: feed fetched exactly once, Load more uses memory', feedRequests.length === 1, `${feedRequests.length} request(s)`);

  if (SHOT_DIR) await page.screenshot({ path: shot('desktop-full'), fullPage: false });

  /* -------------------------------------------------- injection safety */
  const report = await page.locator('#xss-report').textContent();
  check('security: preview injection check passes', /passed/i.test(report), report.trim().slice(0, 120));
  check('security: no alert() fired from testimonial content', dialogs.length === 0, dialogs.join(' | '));
  check('security: no uncaught page errors', errors.length === 0, errors.join(' | '));

  const rawVisible = await page.locator('.jg-wol__text', { hasText: 'XSS-message' }).count();
  check('security: script tag from feed rendered as literal text', rawVisible === 1, `matches: ${rawVisible}`);
  const jsUrls = await page.locator('a[href^="javascript:"], img[src^="javascript:"]').count();
  check('security: no javascript: URL reached the DOM', jsUrls === 0);
  const injected = await page.locator('.jg-wol iframe, .jg-wol script').count();
  check('security: no injected iframe/script nodes', injected === 0);

  /* -------------------------------------------------- no private data */
  const html = await page.locator('.jg-wol').innerHTML();
  const leaks = ['@example.com', 'notionPageId', 'migrationKey', 'testimonial.to:', 'Raw Capture', 'Import Batch']
    .filter((needle) => html.includes(needle));
  check('privacy: no private field or value in the DOM', leaks.length === 0, leaks.join(', '));

  /* -------------------------------------------------- graceful degradation */
  const monograms = await page.locator('.jg-wol__monogram').count();
  check('graceful: missing/broken avatars fall back to a monogram', monograms >= 6, `${monograms} monograms`);
  const imageOnly = await page.locator('.jg-wol__card:has(.jg-wol__shot):not(:has(.jg-wol__text))').count();
  check('graceful: image-only card renders without message text', imageOnly >= 1, `${imageOnly} card(s)`);
  const anon = await page.locator('.jg-wol__name', { hasText: 'Anonymous' }).count();
  check('graceful: missing name falls back to "Anonymous"', anon === 1);
  const cards = await page.locator('.jg-wol__card').count();
  const metas = await page.locator('.jg-wol__meta').count();
  check('graceful: cards with no role and no company omit the meta line', metas < cards, `${metas} meta / ${cards} cards`);

  const overlap = await page.locator('.jg-wol__meta', { hasText: 'Lead PM @ Northwind' }).first().textContent();
  check('graceful: an employer named in both role and company prints once',
    overlap.trim() === 'Lead PM @ Northwind', `got "${overlap.trim()}"`);

  /* -------------------------------------------------- ordering */
  const names = await page.locator('.jg-wol__name').allTextContents();
  const feed = fixture;

  // Derived from the fixture rather than hardcoded, so renaming the synthetic
  // people cannot silently turn this into a test of nothing.
  const featuredNames = feed.testimonials.filter((t) => t.featured).map((t) => t.name);
  const leading = names.slice(0, featuredNames.length).map((n) => n.replace(/\s*\(opens in a new tab\)\s*$/, ''));
  check('ordering: featured records render first',
    featuredNames.length > 0 && JSON.stringify(leading) === JSON.stringify(featuredNames),
    `expected ${JSON.stringify(featuredNames)}, got ${JSON.stringify(leading)}`);

  const feedOrder = feed.testimonials.map((t) => (t.name || 'Anonymous').replace(/\s*\(opens.*$/, ''));
  const domOrder = names.map((n) => n.replace(/\s*\(opens in a new tab\)\s*$/, ''));
  check('ordering: DOM order matches JSON order exactly, no re-sorting',
    JSON.stringify(domOrder) === JSON.stringify(feedOrder),
    `first mismatch at ${domOrder.findIndex((n, i) => n !== feedOrder[i])}`);

  /* -------------------------------------------------- accessibility */
  const section = page.locator('.jg-wol section');
  check('a11y: section has an accessible label', !!(await section.getAttribute('aria-label')));
  check('a11y: list markup is a real ul/li',
    (await page.locator('ul.jg-wol__grid > li.jg-wol__card').count()) === TOTAL);
  check('a11y: a polite live region reports progress', (await page.locator('.jg-wol [role="status"][aria-live="polite"]').count()) === 1);
  const extLinks = await page.locator('.jg-wol a[target="_blank"]').count();
  const relOk = await page.locator('.jg-wol a[target="_blank"][rel*="noopener"]').count();
  check('a11y/security: every new-tab link carries rel=noopener', extLinks > 0 && extLinks === relOk, `${relOk}/${extLinks}`);

  // Clamping: only the genuinely long quote should offer "Show more".
  const visibleToggles = page.locator('.jg-wol__more:visible');
  const toggleCount = await visibleToggles.count();
  check('clamp: only over-long quotes get a Show more control', toggleCount === 1, `${toggleCount} visible toggle(s)`);

  const clampedBefore = await page.locator('.jg-wol__text--clamped').count();
  check('clamp: the long quote is clamped, short ones are not', clampedBefore === 1, `${clampedBefore} clamped`);

  const toggle = visibleToggles.first();
  await toggle.focus();
  const focusedClass = await page.evaluate(() => document.activeElement.className);
  check('keyboard: Show more toggle is focusable', /jg-wol__more/.test(focusedClass), focusedClass);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const expanded = await toggle.getAttribute('aria-expanded');
  const label = await toggle.textContent();
  const clampedAfter = await page.locator('.jg-wol__text--clamped').count();
  check('keyboard: Enter expands the clamped quote and updates aria-expanded',
    expanded === 'true' && /Show less/.test(label) && clampedAfter === 0,
    `aria-expanded=${expanded}, label="${label.trim()}", still-clamped=${clampedAfter}`);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('keyboard: Enter again re-collapses the quote',
    (await toggle.getAttribute('aria-expanded')) === 'false' &&
    (await page.locator('.jg-wol__text--clamped').count()) === 1);

  // Focus visibility: assert what actually paints. A CSSOM check is unreliable
  // here because a shorthand containing var() does not expand to longhands.
  // Reach the control by keyboard: :focus-visible deliberately does not match
  // after a mouse click, so a programmatic focus would under-report the ring.
  await page.evaluate(() => document.body.focus());
  let ring = { style: 'none', width: '0px', color: '' };
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const probe = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || !active.closest || !active.closest('.jg-wol')) return null;
      if (active.tagName !== 'BUTTON' && active.tagName !== 'A') return null;
      const cs = getComputedStyle(active);
      return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, tag: active.tagName };
    });
    if (probe) { ring = probe; break; }
  }
  check('a11y: a keyboard-focused control paints a visible outline',
    ring.style === 'solid' && parseFloat(ring.width) >= 2,
    `${ring.tag || '?'}: ${ring.width} ${ring.style} ${ring.color}`);

  await context.close();
}

/* ------------------------------------------------ keyboard focus on Load more */
{
  const { page, context } = await newPage({ width: 1280, height: 1000 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.jg-wol__card');
  const btn = page.locator('.jg-wol__btn', { hasText: 'Load more' });
  await btn.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const movedToNewCard = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active || !active.classList.contains('jg-wol__card')) return false;
    return Array.prototype.indexOf.call(active.parentNode.children, active) === 24;
  });
  check('keyboard: Load more moves focus to the first newly revealed card', movedToNewCard);
  const total = (await (await fetch(`${ORIGIN}/widgets/fixtures/preview-feed.json`)).json()).testimonials.length;
  const count = await page.locator('.jg-wol__card').count();
  check('keyboard: Load more via Enter reveals the next batch', count === total, `got ${count}, expected ${total}`);
  await context.close();
}

/* ------------------------------------------------------------- homepage */
{
  const { page, context } = await newPage({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#scenarios button', { hasText: 'Homepage teaser' }).click();
  await page.waitForTimeout(600);
  const count = await page.locator('.jg-wol__card').count();
  check('homepage: data attributes override the default card count (6)', count === 6, `got ${count}`);
  await page.locator('.jg-wol__btn', { hasText: 'Load more' }).click();
  await page.waitForTimeout(250);
  const after = await page.locator('.jg-wol__card').count();
  check('homepage: batch size of 6 honoured', after === 12, `got ${after}`);
  if (SHOT_DIR) await page.screenshot({ path: shot('homepage') });
  await context.close();
}

/* ---------------------------------------------------------------- empty */
{
  const { page, context } = await newPage({ width: 1100, height: 700 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#scenarios button', { hasText: 'Empty results' }).click();
  await page.waitForTimeout(600);
  const note = await page.locator('.jg-wol__note').textContent();
  check('empty: shows the empty state, not an error', /No testimonials to show/.test(note), note.trim());
  check('empty: no cards and no Load more', (await page.locator('.jg-wol__card').count()) === 0 &&
    (await page.locator('.jg-wol__btn').count()) === 0);
  if (SHOT_DIR) await page.screenshot({ path: shot('empty') });
  await context.close();
}

/* ---------------------------------------------------------------- error */
{
  const { page, context } = await newPage({ width: 1100, height: 700 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#scenarios button', { hasText: 'Failed network' }).click();
  await page.waitForTimeout(800);
  const note = await page.locator('.jg-wol__note').textContent();
  check('error: failed fetch shows the error state', /could not be loaded/.test(note), note.trim().slice(0, 80));
  const retry = page.locator('.jg-wol__btn', { hasText: 'Try again' });
  check('error: a Try again button is offered', await retry.isVisible());
  await retry.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  check('error: Try again re-runs the fetch and keeps the error state', await page.locator('.jg-wol__note').isVisible());
  if (SHOT_DIR) await page.screenshot({ path: shot('error') });
  await context.close();
}

/* --------------------------------------------------------------- mobile */
{
  const { page, context } = await newPage({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.jg-wol__card');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile (390px): no horizontal overflow', overflow <= 0, `overflow ${overflow}px`);
  const cols = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.jg-wol__grid')).gridTemplateColumns.split(' ').length);
  check('mobile: masonry collapses to a single column', cols === 1, `${cols} column(s)`);
  const tap = await page.evaluate(() => {
    const b = document.querySelector('.jg-wol__btn');
    return b ? b.getBoundingClientRect().height : 0;
  });
  check('mobile: Load more meets the 44px touch target', tap >= 44, `${Math.round(tap)}px`);
  if (SHOT_DIR) await page.screenshot({ path: shot('mobile'), fullPage: false });
  await context.close();
}

/* -------------------------------------------------------- theme override */
{
  const { page, context } = await newPage({ width: 1100, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#scenarios button', { hasText: 'Theme override' }).click();
  await page.waitForTimeout(700);
  const accent = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.jg-wol')).getPropertyValue('--jg-wol-accent').trim());
  check('theme: config theme overrides the accent custom property', accent === '#1A7A3C', accent);
  if (SHOT_DIR) await page.screenshot({ path: shot('themed') });
  await context.close();
}

/* --------------------------------------------- CSS containment / no leakage */
{
  const { page, context } = await newPage({ width: 1100, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.jg-wol__card');
  const source = await (await fetch(`${ORIGIN}/widgets/wall-of-love.html`)).text();
  const rawCss = source.slice(source.indexOf('<style>') + 7, source.indexOf('</style>'));
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');   // comments are not selectors

  // Split top-level selector lists on commas that are not inside parentheses,
  // so `.jg-wol :is(button, a)` stays one selector.
  const splitSelectors = (text) => {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(current); current = ''; } else current += ch;
    }
    out.push(current);
    return out.map((s) => s.trim()).filter(Boolean);
  };

  const selectors = css.split('}')
    .map((block) => block.split('{')[0].trim())
    .filter(Boolean)
    .flatMap(splitSelectors)
    .filter((sel) => !sel.startsWith('@') && !/^(from|to|\d+%)$/.test(sel));

  const unscoped = selectors.filter((sel) => !sel.includes('.jg-wol'));
  check('css: every selector is scoped under .jg-wol', unscoped.length === 0,
    unscoped.length ? unscoped.join(' | ') : `${selectors.length} selectors checked`);
  check('css: no :root custom properties declared', !css.includes(':root'));
  // Safari mis-measures multi-column boxes and left a viewport of blank space
  // below the wall. The layout must not go back to it.
  check('css: layout does not use CSS multi-column',
    !/\bcolumns\s*:/.test(css) && !/\bcolumn-count\s*:/.test(css) && !/break-inside/.test(css));
  check('css: no bare element or wildcard selectors that could hit Squarespace',
    !selectors.some((sel) => /^(\*|html|body|h[1-6]|p|a|ul|li|img|button|section|figure)\b/.test(sel)));

  // The harness page's own h1/body styling must be untouched by the widget.
  const headingFont = await page.evaluate(() => getComputedStyle(document.querySelector('header h1')).fontFamily);
  check('css: host page typography unaffected by the widget', !/nohemi/i.test(headingFont), headingFont);
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exitCode = 1;
}
