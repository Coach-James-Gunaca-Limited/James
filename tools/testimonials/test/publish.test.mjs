/**
 * Filtering, ordering, missing fields and private-field leakage.
 * Run with: node --test tools/testimonials/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildFeed } from '../publish-json.mjs';
import { publicId, toPublicRecord, isPublishable, sortPublicRecords, PUBLIC_FIELDS, FORBIDDEN_FIELDS } from '../lib/rows.mjs';
import { validate, assertValid } from '../lib/validate.mjs';
import { isLegacyMediaUrl, isRehostedUrl, assetFilename, detectImageExtension } from '../lib/assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(await readFile(resolve(here, 'fixtures/rows.json'), 'utf8'));
const schema = JSON.parse(await readFile(resolve(here, '..', 'schema', 'approved-testimonials.schema.json'), 'utf8'));

const feed = buildFeed(rows, { generatedAt: '2026-09-05T00:00:00.000Z' });
const byKey = (key) => feed.testimonials.find((t) => t.id === publicId(key));

test('filtering: only Approved for Use AND consented rows publish', () => {
  assert.equal(feed.meta.count, 6);

  // Present: approved + consented.
  for (const key of [
    'testimonial.to:-APPROVED-FEATURED',
    'testimonial.to:-APPROVED-NEWER',
    'testimonial.to:-APPROVED-OLDER',
    'testimonial.to:-APPROVED-NODATE',
    'testimonial.to:-XSS',
    'testimonial.to:-APPROVED-LEGACY-MEDIA',
  ]) {
    assert.ok(byKey(key), `expected ${key} to be published`);
  }

  // Absent: each excluded for a different reason.
  assert.equal(byKey('testimonial.to:-NEW-BUT-CONSENTED'), undefined, 'consent alone must not publish');
  assert.equal(byKey('testimonial.to:-APPROVED-NO-CONSENT'), undefined, 'approval alone must not publish');
  assert.equal(byKey('testimonial.to:-ARCHIVED'), undefined, 'archived must not publish');
});

test('filtering: isPublishable requires both signals', () => {
  assert.equal(isPublishable({ status: 'Approved for Use', consentToPublish: true }), true);
  assert.equal(isPublishable({ status: 'Approved for Use', consentToPublish: false }), false);
  assert.equal(isPublishable({ status: 'New', consentToPublish: true }), false);
  assert.equal(isPublishable({ status: 'Tagged', consentToPublish: true }), false);
  assert.equal(isPublishable({ status: 'Needs Follow-up', consentToPublish: true }), false);
  assert.equal(isPublishable({ status: 'Archived', consentToPublish: true }), false);
  // A missing checkbox must not be treated as consent.
  assert.equal(isPublishable({ status: 'Approved for Use' }), false);
});

test('ordering: featured first, then date descending, undated last', () => {
  const order = feed.testimonials.map((t) => t.name);
  assert.deepEqual(order, [
    'Featured Person',       // featured wins regardless of its older date
    'Newer Person',          // 2026-06-01
    'Legacy Media Person',   // 2026-05-05
    '<img src=x onerror=alert(\'name\')>', // 2026-02-02
    'Older Person',          // 2025-03-09
    'No Date Person',        // null date sorts last
  ]);
});

test('ordering: deterministic across shuffles of the same input', () => {
  const shuffled = [...rows].reverse();
  const again = buildFeed(shuffled, { generatedAt: '2026-09-05T00:00:00.000Z' });
  assert.deepEqual(again.testimonials, feed.testimonials);
});

test('ordering: equal featured and date tie-break on id, stably', () => {
  const sameDate = [
    { id: 'tbbbbbbbbbbbbbbbb', featured: false, dateReceived: '2026-01-01' },
    { id: 'taaaaaaaaaaaaaaaa', featured: false, dateReceived: '2026-01-01' },
  ];
  assert.deepEqual(sortPublicRecords(sameDate).map((r) => r.id), ['taaaaaaaaaaaaaaaa', 'tbbbbbbbbbbbbbbbb']);
});

test('missing fields: optional properties become null, never undefined', () => {
  const older = byKey('testimonial.to:-APPROVED-OLDER');
  assert.equal(older.roleTitle, null);
  assert.equal(older.company, null);
  assert.equal(older.avatarUrl, null);
  assert.equal(older.attachedImageUrl, null);
  assert.equal(older.socialLink, null);
  for (const field of PUBLIC_FIELDS) {
    assert.ok(Object.hasOwn(older, field), `${field} must always be present`);
    assert.notEqual(older[field], undefined, `${field} must not be undefined`);
  }
});

test('missing fields: a row with no date still publishes', () => {
  const undated = byKey('testimonial.to:-APPROVED-NODATE');
  assert.equal(undated.dateReceived, null);
  assert.equal(undated.testimonialFormat, null);
});

test('missing fields: absent properties on the source row do not throw', () => {
  const sparse = { migrationKey: 'testimonial.to:-SPARSE', status: 'Approved for Use', consentToPublish: true };
  const record = toPublicRecord(sparse);
  assert.equal(record.name, null);
  assert.equal(record.featured, false);
  assert.deepEqual(Object.keys(record).sort(), [...PUBLIC_FIELDS].sort());
});

test('leakage: no record carries any key outside the public allowlist', () => {
  for (const record of feed.testimonials) {
    assert.deepEqual(Object.keys(record).sort(), [...PUBLIC_FIELDS].sort());
  }
});

test('leakage: no forbidden Notion field name appears anywhere in the payload', () => {
  const serialised = JSON.stringify(feed);
  for (const field of FORBIDDEN_FIELDS) {
    assert.ok(!serialised.includes(`"${field}"`), `payload leaked field name "${field}"`);
  }
});

test('leakage: private values from the source rows never reach the payload', () => {
  const serialised = JSON.stringify(feed);
  for (const value of ['private@example.com', 'internal provenance note', 'batch-01', 'relation-page-id']) {
    assert.ok(!serialised.includes(value), `payload leaked private value "${value}"`);
  }
});

test('leakage: no Notion page id and no Migration Key reach the payload', () => {
  const serialised = JSON.stringify(feed);
  for (const row of rows) {
    assert.ok(!serialised.includes(row.pageId), `payload leaked page id ${row.pageId}`);
    assert.ok(!serialised.includes(row.migrationKey), `payload leaked Migration Key ${row.migrationKey}`);
  }
});

test('ids: derived from the Migration Key, stable, and public-safe', () => {
  const id = publicId('testimonial.to:-OaKqIoHcErW8I-wHNA1');
  assert.match(id, /^t[0-9a-f]{16}$/);
  assert.equal(id, publicId('testimonial.to:-OaKqIoHcErW8I-wHNA1'), 'must be stable across calls');
  assert.notEqual(id, publicId('testimonial.to:-OaKqIoHcErW8I-wHNA2'), 'must differ per key');
  assert.equal(new Set(feed.testimonials.map((t) => t.id)).size, feed.meta.count, 'ids must be unique');
  assert.throws(() => publicId(''), /non-empty/);
  assert.throws(() => publicId(null), /non-empty/);
});

test('malicious content is carried verbatim, not sanitised away, and stays inert as data', () => {
  const xss = byKey('testimonial.to:-XSS');
  // The publisher must not silently mangle the text; escaping is the widget's
  // job, and it does it by assigning to textContent rather than innerHTML.
  assert.ok(xss.message.includes('<script>alert(\'xss\')</script>'));
  assert.ok(xss.name.includes('onerror='));
  // JSON.stringify is the serialisation boundary: nothing can break out of it.
  const roundTripped = JSON.parse(JSON.stringify(xss));
  assert.deepEqual(roundTripped, xss);
});

test('serialisation: the feed survives a JSON round trip unchanged', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(feed)), feed);
});

test('build metadata sits outside the testimonial records', () => {
  assert.equal(feed.meta.schemaVersion, 1);
  assert.equal(feed.meta.generatedAt, '2026-09-05T00:00:00.000Z');
  assert.equal(feed.meta.count, feed.testimonials.length);
  for (const record of feed.testimonials) {
    assert.ok(!Object.hasOwn(record, 'generatedAt'));
    assert.ok(!Object.hasOwn(record, 'meta'));
  }
});

test('schema: the generated feed validates', () => {
  assertValid(feed, schema, 'fixture feed');
});

test('schema: an empty feed is valid', () => {
  assertValid(buildFeed([]), schema, 'empty feed');
  assert.equal(buildFeed([]).meta.count, 0);
});

test('schema: validation rejects an injected private field', () => {
  const tampered = structuredClone(feed);
  tampered.testimonials[0].email = 'leak@example.com';
  const { valid, errors } = validate(tampered, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unexpected property "email"')), errors.join('; '));
});

test('schema: validation rejects a malformed id, bad date and unknown format', () => {
  const tampered = structuredClone(feed);
  tampered.testimonials[0].id = 'NOT-AN-ID';
  tampered.testimonials[1].dateReceived = '01/06/2026';
  tampered.testimonials[2].testimonialFormat = 'Interpretive Dance';
  const { valid, errors } = validate(tampered, schema);
  assert.equal(valid, false);
  assert.equal(errors.length, 3, errors.join('; '));
});

test('schema: validation rejects a missing required property', () => {
  const tampered = structuredClone(feed);
  delete tampered.testimonials[0].company;
  const { valid, errors } = validate(tampered, schema);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('missing required property "company"')));
});

test('media: legacy testimonial.to hosts are recognised', () => {
  assert.equal(isLegacyMediaUrl('https://firebasestorage.googleapis.com/v0/b/testimonialto.appspot.com/o/x?alt=media'), true);
  assert.equal(isLegacyMediaUrl('https://testimonial.to/some/asset.png'), true);
  assert.equal(isLegacyMediaUrl('https://embed-v2.testimonial.to/asset.png'), true);
  assert.equal(isLegacyMediaUrl('https://media.jamesgunaca.com/img/testimonials/t1-avatar.webp'), false);
  assert.equal(isLegacyMediaUrl('https://linkedin.com/in/example'), false);
  assert.equal(isLegacyMediaUrl(null), false);
  assert.equal(isLegacyMediaUrl(''), false);
  assert.equal(isLegacyMediaUrl('not a url'), false);
  assert.equal(isLegacyMediaUrl('javascript:alert(1)'), false);
});

test('media: rehosted URLs are recognised so reruns skip them', () => {
  const base = 'https://media.jamesgunaca.com';
  assert.equal(isRehostedUrl('https://media.jamesgunaca.com/img/testimonials/t1-avatar.webp', base), true);
  assert.equal(isRehostedUrl('https://firebasestorage.googleapis.com/x', base), false);
  assert.equal(isRehostedUrl(null, base), false);
});

test('media: filenames are deterministic per Migration Key and asset type', () => {
  const key = 'testimonial.to:-OQPrG6om1pirEWUTBVj';
  assert.equal(assetFilename(key, 'avatar', 'webp'), `${publicId(key)}-avatar.webp`);
  assert.equal(assetFilename(key, 'avatar', 'webp'), assetFilename(key, 'avatar', 'webp'));
  assert.notEqual(assetFilename(key, 'avatar', 'webp'), assetFilename(key, 'attached', 'webp'));
  assert.throws(() => assetFilename(key, 'video', 'mp4'), /Unknown asset kind/);
});

test('media: image formats are detected from bytes, not Content-Type', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(detectImageExtension(webp), 'webp');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(detectImageExtension(png), 'png');

  // An HTML error page served with a 200 must not pass as an image.
  assert.equal(detectImageExtension(Buffer.from('<!doctype html><html><body>Not found</body></html>')), null);
  assert.equal(detectImageExtension(Buffer.alloc(0)), null);
});
