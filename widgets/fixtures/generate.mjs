#!/usr/bin/env node
/**
 * Regenerates the preview fixtures.
 *
 * Everything the preview renders is SYNTHETIC. The fixtures must never
 * reference anything under img/testimonials/: that directory holds real
 * clients' photographs and screenshots, and this repository is public, so
 * pairing those images with invented names, employers and quotes would publish
 * fabricated testimonials wearing real people's likenesses.
 *
 * Placeholder avatars are generated per record and carry that record's own
 * initials, so the face can never disagree with the name beside it.
 *
 * Run:  node widgets/fixtures/generate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MEDIA_DIR = path.join(OUT_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Deterministic hue per name, so a rerun produces identical bytes. */
function hue(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function initials(name) {
  const parts = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatarSvg(name) {
  const h = hue(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="Placeholder avatar">
  <title>Placeholder avatar - synthetic fixture data</title>
  <rect width="96" height="96" fill="hsl(${h} 42% 88%)"/>
  <circle cx="48" cy="38" r="17" fill="hsl(${h} 38% 72%)"/>
  <path d="M14 96c0-19 15-31 34-31s34 12 34 31z" fill="hsl(${h} 38% 72%)"/>
  <text x="48" y="52" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="26" font-weight="600" fill="hsl(${h} 55% 28%)">${esc(initials(name))}</text>
</svg>
`;
}

/** A clearly fake "screenshot", so no real conversation is ever re-attributed. */
function screenshotSvg(label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" role="img" aria-label="Placeholder screenshot">
  <title>Placeholder screenshot - synthetic fixture data</title>
  <rect width="900" height="520" fill="#F6F8FC"/>
  <rect x="1" y="1" width="898" height="518" fill="none" stroke="#D8E0EB" stroke-width="2"/>
  <rect x="0" y="0" width="900" height="54" fill="#E8ECF3"/>
  <circle cx="30" cy="27" r="7" fill="#C0392B"/><circle cx="54" cy="27" r="7" fill="#FDD488"/><circle cx="78" cy="27" r="7" fill="#84C1AA"/>
  <text x="110" y="33" font-family="system-ui, sans-serif" font-size="15" fill="#6B7280">${esc(label)}</text>
  <circle cx="70" cy="120" r="24" fill="#D8E0EB"/>
  <rect x="110" y="102" width="240" height="14" rx="7" fill="#D8E0EB"/>
  <rect x="110" y="128" width="150" height="12" rx="6" fill="#E8ECF3"/>
  <rect x="110" y="176" width="700" height="14" rx="7" fill="#E8ECF3"/>
  <rect x="110" y="206" width="640" height="14" rx="7" fill="#E8ECF3"/>
  <rect x="110" y="236" width="690" height="14" rx="7" fill="#E8ECF3"/>
  <rect x="110" y="266" width="420" height="14" rx="7" fill="#E8ECF3"/>
  <text x="450" y="380" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="26" font-weight="700" fill="#79A0C6">PLACEHOLDER</text>
  <text x="450" y="412" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="16" fill="#79A0C6">synthetic fixture data - not a real testimonial</text>
</svg>
`;
}

/* ------------------------------------------------------------------ data */

const long = [
  'I came to the coaching stuck. Not unemployed-stuck, but worse: employed and invisible.',
  'Six years of shipping product and I still could not answer "tell me about yourself"',
  'without apologising for half of it. What changed was not a template. It was being made',
  'to re-read my own history until the through-line was obvious, then to say it out loud',
  'until it stopped sounding rehearsed. We rebuilt the CV, then the profile, then the story',
  'underneath both. Three weeks later I had two first-round interviews from applications I',
  'had already been rejected from once. Six weeks later I had an offer at a level I had',
  'talked myself out of applying for. The salary conversation alone paid for the coaching',
  'several times over, and I still use that framing in every stakeholder meeting.',
].join(' ');

const names = ['Avery Sample','Blake Placeholder','Casey Fixture','Devon Example','Ellis Sample',
  'Frankie Mock','Georgie Stub','Harper Dummy','Indigo Test','Jules Sample','Kai Placeholder',
  'Lennox Fixture','Marlow Example','Noor Sample','Oakley Mock','Pip Stub','Quinn Dummy',
  'Reese Test','Sage Sample','Tatum Placeholder','Umber Fixture','Vale Example','Wren Sample',
  'Xen Mock','Yarrow Stub','Zephyr Dummy','Ash Test','Briar Sample'];
const roles = ['Senior Product Manager','Group Product Manager','Head of Product','Lead PM',
  'Principal PM','Product Director','Product Manager', null];
const cos = ['Northwind','Contoso','Fabrikam','Initech','Umbrella Co','Globex', null,'Acme'];

const written = new Set();
function avatarFor(name) {
  const file = 'avatar-' + initials(name).toLowerCase() + '-' + hue(name) + '.svg';
  if (!written.has(file)) {
    fs.writeFileSync(path.join(MEDIA_DIR, file), avatarSvg(name));
    written.add(file);
  }
  return './fixtures/media/' + file;
}

fs.writeFileSync(path.join(MEDIA_DIR, 'screenshot-a.svg'), screenshotSvg('Placeholder message thread'));
fs.writeFileSync(path.join(MEDIA_DIR, 'screenshot-b.svg'), screenshotSvg('Placeholder review'));

const recs = [];
const id = (n) => 't' + String(n).padStart(16, '0');
let n = 0;
const push = (o) => recs.push(Object.assign({ id: id(++n) }, o));

push({ name: names[0], message: 'The coaching rewired how I talk about my work. Two offers in five weeks.',
  roleTitle: roles[0], company: cos[0], avatarUrl: avatarFor(names[0]), attachedImageUrl: null,
  socialLink: 'https://example.com/in/placeholder', testimonialFormat: 'Written', featured: true, dateReceived: '2026-06-01' });

push({ name: names[1], message: null, roleTitle: roles[1], company: cos[1],
  avatarUrl: avatarFor(names[1]), attachedImageUrl: './fixtures/media/screenshot-a.svg', socialLink: null,
  testimonialFormat: 'Image / Screenshot', featured: true, dateReceived: '2026-05-20' });

push({ name: names[2], message: long, roleTitle: roles[2], company: cos[2],
  avatarUrl: avatarFor(names[2]), attachedImageUrl: null, socialLink: 'https://example.com/in/placeholder2',
  testimonialFormat: 'Written', featured: false, dateReceived: '2026-05-11' });

push({ name: names[3], message: 'No avatar on this one; the monogram should show instead.',
  roleTitle: roles[3], company: cos[3], avatarUrl: null, attachedImageUrl: null, socialLink: null,
  testimonialFormat: 'Written', featured: false, dateReceived: '2026-05-02' });

push({ name: names[4], message: 'This avatar URL 404s, so the monogram should replace it.',
  roleTitle: null, company: cos[4], avatarUrl: './fixtures/media/definitely-missing.svg',
  attachedImageUrl: null, socialLink: null, testimonialFormat: 'Written', featured: false, dateReceived: '2026-04-28' });

push({ name: names[5], message: 'Name only, no role and no company. The meta line should vanish entirely.',
  roleTitle: null, company: null, avatarUrl: avatarFor(names[5]), attachedImageUrl: null, socialLink: null,
  testimonialFormat: 'Written', featured: false, dateReceived: '2026-04-20' });

push({ name: "<img src=x onerror=alert('XSS-name')>",
  message: "<script>alert('XSS-message')</script> Genuinely great & <b>bold</b> coaching -- \"worth it\".",
  roleTitle: '</td></tr><script>alert(1)</script>', company: 'Evil & Co <iframe src=//evil.test>',
  avatarUrl: "javascript:alert('XSS-avatar')", attachedImageUrl: null,
  socialLink: "javascript:alert('XSS-social')", testimonialFormat: 'Written',
  featured: false, dateReceived: '2026-04-15' });

// Employer repeated in both fields, as most imported rows are: the meta line
// must read "Lead PM @ Northwind", not "Lead PM @ Northwind - Northwind".
push({ name: names[7], message: 'Role and company overlap; the company must not be printed twice.',
  roleTitle: 'Lead PM @ Northwind', company: 'Northwind', avatarUrl: avatarFor(names[7]),
  attachedImageUrl: null, socialLink: null, testimonialFormat: 'Written', featured: false, dateReceived: '2026-04-12' });

push({ name: null, message: 'Anonymous testimonial with no name supplied.', roleTitle: 'PM',
  company: null, avatarUrl: null, attachedImageUrl: null, socialLink: null,
  testimonialFormat: 'Written', featured: false, dateReceived: '2026-04-10' });

push({ name: names[6],
  message: 'Three things changed:\n\n1. My CV finally said something.\n2. I stopped apologising in interviews.\n3. I asked for more money and got it.',
  roleTitle: roles[6], company: cos[5], avatarUrl: avatarFor(names[6]), attachedImageUrl: null,
  socialLink: 'https://example.com/in/placeholder3', testimonialFormat: 'Written', featured: false, dateReceived: '2026-04-01' });

for (let i = 0; i < 21; i += 1) {
  const name = names[(i + 7) % names.length];
  push({ name,
    message: 'The coaching turned a scattered job search into a plan I could actually follow. ' +
             'The difference showed up in the first interview after we started.',
    roleTitle: roles[i % roles.length], company: cos[i % cos.length],
    avatarUrl: (i % 4 === 0) ? null : avatarFor(name),
    attachedImageUrl: (i % 7 === 3) ? './fixtures/media/screenshot-b.svg' : null,
    socialLink: (i % 3 === 0) ? 'https://example.com/in/placeholder' + i : null,
    testimonialFormat: 'Written', featured: false,
    dateReceived: new Date(Date.UTC(2026, 2, 28 - i)).toISOString().slice(0, 10) });
}

const stamp = '2026-09-05T12:00:00.000Z';
const source = 'SYNTHETIC PREVIEW FIXTURE - invented people, not real testimonials';

fs.writeFileSync(path.join(OUT_DIR, 'preview-feed.json'),
  JSON.stringify({ meta: { schemaVersion: 1, generatedAt: stamp, count: recs.length, source }, testimonials: recs }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'empty-feed.json'),
  JSON.stringify({ meta: { schemaVersion: 1, generatedAt: stamp, count: 0, source }, testimonials: [] }, null, 2) + '\n');

console.log('records:', recs.length, '| placeholder avatars:', written.size, '| screenshots: 2');
