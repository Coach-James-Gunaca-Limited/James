/**
 * Normalisation of raw Notion pages into plain row objects, plus the strict
 * allowlist that produces the public payload.
 *
 * Everything the public site is allowed to see is enumerated in PUBLIC_FIELDS.
 * Nothing else can reach the JSON feed: `toPublicRecord` builds a fresh object
 * from that list rather than deleting keys off an internal one, so a new private
 * property added to Notion later cannot leak by omission.
 */

import { createHash } from 'node:crypto';

export const APPROVED_STATUS = 'Approved for Use';

/** Notion property names, kept in one place so a rename is a one-line change. */
export const PROP = {
  name: 'Name',
  message: 'Message',
  roleTitle: 'Role / Title',
  company: 'Company',
  avatarUrl: 'Avatar URL',
  attachedImages: 'Attached Images',
  socialLink: 'Social Link',
  testimonialFormat: 'Testimonial Format',
  status: 'Status',
  consent: 'Consent to Publish',
  featured: 'Featured',
  dateReceived: 'Date Received',
  migrationKey: 'Migration Key',
};

/** The only keys permitted in a public testimonial record. */
export const PUBLIC_FIELDS = Object.freeze([
  'id',
  'name',
  'message',
  'roleTitle',
  'company',
  'avatarUrl',
  'attachedImageUrl',
  'socialLink',
  'testimonialFormat',
  'featured',
  'dateReceived',
]);

/**
 * Notion properties that must never appear in public output, listed explicitly
 * so the leakage test has something concrete to assert against.
 */
export const FORBIDDEN_FIELDS = Object.freeze([
  'Email',
  'email',
  'Person',
  'person',
  'Raw Capture',
  'rawCapture',
  'Migration Key',
  'migrationKey',
  'Import Batch',
  'importBatch',
  'Intake Source',
  'intakeSource',
  'Status',
  'status',
  'Consent to Publish',
  'consentToPublish',
  'pageId',
  'page_id',
  'Has Media',
  'hasMedia',
  'Outcome',
  'Role Level',
  'Service Area',
  'Source Tags',
  'Usable For',
]);

/**
 * Derive a stable, public-safe identifier from the Migration Key.
 *
 * A hash rather than a slug of the key itself: it is deterministic across runs,
 * cannot collide, is safe as an HTML id or filename, and does not publish the
 * vendor-internal record id embedded in every key.
 */
export function publicId(migrationKey) {
  if (typeof migrationKey !== 'string' || !migrationKey.trim()) {
    throw new Error('publicId requires a non-empty Migration Key');
  }
  return `t${createHash('sha256').update(migrationKey.trim()).digest('hex').slice(0, 16)}`;
}

/**
 * Tidy whitespace, and defensively convert a literal `<br>` to a real newline.
 *
 * Notion itself stores real line breaks, not `<br>` tags: an audit of all 52
 * imported rows found zero literal `<br>` in either Message or Raw Capture. An
 * earlier version of this comment claimed otherwise, having mistaken the MCP
 * rows-serialiser's rendering of line breaks for the stored data.
 *
 * The conversion is kept because the widget renders testimonial text as plain
 * text and never as HTML, so a `<br>` arriving from some other intake path -
 * someone pasting formatted text into the Notion form, say - would otherwise
 * show up on the page as a visible "<br>". Against today's data it is a no-op;
 * the collapsing of blank-line runs is what actually does work.
 *
 * Deliberately narrow: only <br>, <br/> and <br />. Every other tag stays
 * literal text and is escaped by the widget like any other character.
 */
export function normaliseLineBreaks(value) {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

const richText = (prop) =>
  Array.isArray(prop?.rich_text)
    ? normaliseLineBreaks(prop.rich_text.map((t) => t.plain_text ?? '').join(''))
    : '';

const titleText = (prop) =>
  Array.isArray(prop?.title)
    ? normaliseLineBreaks(prop.title.map((t) => t.plain_text ?? '').join(''))
    : '';

/** Trim, and collapse an empty string to null so optional fields are uniform. */
const orNull = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' || trimmed === undefined ? null : trimmed;
};

/**
 * Convert one Notion page object into a flat internal row.
 * Internal fields (pageId, status, migrationKey) stay on this object; they are
 * needed by the migration script and are stripped by `toPublicRecord`.
 */
export function normaliseRow(page) {
  const p = page.properties ?? {};
  return {
    pageId: page.id,
    migrationKey: orNull(richText(p[PROP.migrationKey])),
    status: p[PROP.status]?.select?.name ?? null,
    consentToPublish: p[PROP.consent]?.checkbox === true,
    featured: p[PROP.featured]?.checkbox === true,
    dateReceived: orNull(p[PROP.dateReceived]?.date?.start ?? null),
    name: orNull(titleText(p[PROP.name])),
    message: orNull(richText(p[PROP.message])),
    roleTitle: orNull(richText(p[PROP.roleTitle])),
    company: orNull(richText(p[PROP.company])),
    avatarUrl: orNull(p[PROP.avatarUrl]?.url ?? null),
    attachedImageUrl: orNull(p[PROP.attachedImages]?.url ?? null),
    socialLink: orNull(p[PROP.socialLink]?.url ?? null),
    testimonialFormat: p[PROP.testimonialFormat]?.select?.name ?? null,
  };
}

/** A row is publishable only when moderation approved it AND consent is on. */
export function isPublishable(row) {
  return row.status === APPROVED_STATUS && row.consentToPublish === true;
}

/**
 * Build the public record. Constructed field-by-field from PUBLIC_FIELDS, never
 * by copying and deleting, so private properties cannot survive by accident.
 */
export function toPublicRecord(row) {
  return {
    id: publicId(row.migrationKey),
    name: row.name ?? null,
    message: row.message ?? null,
    roleTitle: row.roleTitle ?? null,
    company: row.company ?? null,
    avatarUrl: row.avatarUrl ?? null,
    attachedImageUrl: row.attachedImageUrl ?? null,
    socialLink: row.socialLink ?? null,
    testimonialFormat: row.testimonialFormat ?? null,
    featured: row.featured === true,
    dateReceived: row.dateReceived ?? null,
  };
}

/**
 * Featured descending, then Date Received descending, then id ascending.
 *
 * The id tie-break is what makes the ordering deterministic: without it two rows
 * sharing a date could swap places between runs and churn the committed JSON.
 * Rows with no date sort after rows that have one.
 */
export function sortPublicRecords(records) {
  return [...records].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.dateReceived !== b.dateReceived) {
      if (!a.dateReceived) return 1;
      if (!b.dateReceived) return -1;
      return a.dateReceived < b.dateReceived ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
