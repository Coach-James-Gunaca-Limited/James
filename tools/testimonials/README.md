# Testimonials — migration, publishing and the Wall of Love widget

Replaces testimonial.to with a Notion-backed pipeline:

```
Notion "Testimonials" database
  -> tools/testimonials/publish-json.mjs
  -> testimonials/approved.json  (served by media.jamesgunaca.com)
  -> widgets/wall-of-love.html   (pasted into a Squarespace code block)
```

Media that testimonial.to hosted lives at `img/testimonials/` in this
repository and is served from `https://media.jamesgunaca.com/img/testimonials/`.

---

## Current state

| Thing | State |
|---|---|
| testimonial.to subscription | **Active. Not cancelled.** |
| Existing Squarespace embeds | **Untouched. No cutover has happened.** |
| Media rescued | 34 of 34 (25 avatars, 9 attached images) |
| Notion `Avatar URL` / `Attached Images` | **Still pointing at testimonial.to.** Repointing needs `--apply`, which needs `NOTION_TOKEN`. |
| `testimonials/approved.json` | Published, `count: 0` |
| Approved testimonials | 0 of 52 — all rows are still `Status = New` |

The feed is empty because nothing has been approved yet, not because anything
is broken. The widget renders its empty state until moderation runs.

---

## Architecture, and why

**Assets and feed both live in this repository**, served by GitHub Pages on the
existing `media.jamesgunaca.com` custom domain. That host already serves the
monthly jobs report and newsletter images, so testimonials introduce no new
infrastructure, no new domain and no new paid service. Anonymous `GET` works,
GitHub's CDN sits in front of it, and rolling back is `git revert`.

A Cloudflare Worker in `coachjamesgunaca/notion-workers` was considered for
serving the feed live from Notion. It was **not** evaluated in detail: that
repository is private and under a different owner, so the session doing this
work could not read it. The GitHub-hosted route was chosen as the documented
fallback. Reasons to revisit it later: the feed would reflect moderation
changes instantly instead of after a publish, and there would be no committed
JSON to keep in sync. Reasons not to: it adds a runtime dependency and a
failure mode to a page that currently has neither.

### Where the images live, and why not in Notion

**Notion stays the source of truth for which photo belongs to whom.** The
`Avatar URL` and `Attached Images` properties hold the URL; the bytes live in
`img/testimonials/` in this repository.

Uploading the images into Notion as file attachments instead does not work for
this use case. Notion serves uploaded files from **signed URLs that expire**
(on the order of an hour). A public web page cannot use those as image sources:
the wall would render correctly when you tested it and show broken images to
visitors soon after. External-URL properties, which is what these are, have no
such expiry.

So the split is:

| | |
|---|---|
| Notion | who the testimonial is from, what it says, whether it may be published, and the URL of their photo |
| This repository | the image bytes, served over the existing Pages CDN |

**Each file is bound to one person by construction.** The filename is
`t<sha256(Migration Key)[0:16]>-<avatar\|attached>.<ext>`, and the Migration Key
is unique per row, so a file can only ever belong to the row it was downloaded
from. There is no separate lookup table to drift out of sync, and nothing to
re-match by hand.

Verify it, including a visual check that testimonial.to attached the right face
to the right person in its own export:

```bash
cd tools/testimonials && npm run verify:mapping
# writes .migration/mapping-proof.html - open it and check each face vs its name
```

It reports unresolved assets, orphan files, files claimed by more than one row,
and duplicate display names. The proof sheet pairs real names with real faces,
so it is written to the git-ignored `.migration/` directory and must not be
committed.

**Ids are a SHA-256 of the Migration Key**, truncated to 16 hex characters
(`t6918223b6be02717`). Stable across runs, collision-free, safe as a filename
and an HTML id, and it does not publish the testimonial.to record id that every
Migration Key embeds.

**No runtime dependencies.** Everything runs on a stock Node 20+ install.
Playwright is needed only for the browser tests and is resolved from wherever
it happens to be installed.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NOTION_TOKEN` | For any Notion read or write | — | Notion internal integration token. **Never commit, never paste into a file, never echo it.** |
| `NOTION_TESTIMONIALS_DATA_SOURCE_ID` | No | `96263e5afce34b03889e0d852e9a0266` | |
| `NOTION_TESTIMONIALS_DATABASE_ID` | No | `fe6d63c717f14c578c96d83028f8ecb2` | |
| `TESTIMONIALS_PUBLIC_BASE` | No | `https://media.jamesgunaca.com` | |
| `TESTIMONIALS_RAW_BASE` | No | `raw.githubusercontent.com/.../main` | Fallback used only to verify a freshly committed asset is public. |

Set the token for one shell session only:

```bash
read -rs NOTION_TOKEN && export NOTION_TOKEN
```

`read -rs` keeps the token off screen and out of shell history. Do not put it in
`.zshrc`, a `.env` file inside this repository, or a commit. The scripts read it
at call time and redact anything token-shaped from error output.

The Notion integration must be shared with the **Testimonials** database:
Notion → the database → `...` → Connections → add the integration. Without that
every query returns 404, which looks like a wrong id but is a permissions
problem.

---

## Runbooks

### Rerun the media migration

Always dry-run first. It touches nothing.

```bash
cd tools/testimonials
npm run migrate:dry
```

Then, in order:

```bash
npm run migrate:download        # download + validate + write files. No Notion writes.
cd ../.. && git add img/testimonials testimonials/media-manifest.json
git commit -m "Rescue testimonial media" && git push
# wait for Pages to deploy, then confirm one asset is live:
curl -sI https://media.jamesgunaca.com/img/testimonials/<file> | head -1
cd tools/testimonials && npm run migrate:apply   # verify public URLs, then repoint Notion
```

The split matters. `--download` gets the bytes off testimonial.to; `--apply`
only repoints Notion **after** confirming the replacement URL responds. Nothing
overwrites an original URL until its replacement is proven live, so an
interrupted run can never leave a dead URL in Notion.

The script is safe to rerun at any point:

- filenames derive from the Migration Key and asset type, so a rerun rewrites
  the same path rather than creating duplicates;
- a file already on disk with a matching checksum is not re-downloaded;
- a row whose Notion URL already points at `media.jamesgunaca.com` is skipped;
- one failed asset is logged and the run continues with the rest.

Useful flags: `--limit N` for a smoke test, `--force` to re-download regardless
of checksum, `--rows-file PATH` to replay from a saved rows file instead of
querying Notion.

**Manifests.** `--download` and `--apply` write two:

- `.migration/media-manifest.json` — the full record: Notion page id, Migration
  Key, original URL, new URL, asset type, checksum, bytes, status. This is the
  rollback source. It is **git-ignored** because the original Firebase URLs
  embed download tokens and this repository is public. Keep it somewhere safe
  outside the repo.
- `testimonials/media-manifest.json` — committed. Same records with the page
  id, Migration Key and URL query string stripped.

### Publish the JSON feed

Publication is manual and explicit; there is no scheduled job. Run it after
moderation changes.

```bash
cd tools/testimonials
npm run publish:dry     # counts only, writes nothing
npm run publish         # writes ../../testimonials/approved.json
cd ../.. && git add testimonials/approved.json
git commit -m "Publish approved testimonials" && git push
```

The feed is live at `https://media.jamesgunaca.com/testimonials/approved.json`
once Pages deploys (usually under a minute).

If the run stops with *"N published record(s) still point at testimonial.to
media"*, that is the guard working: those rows would go live against URLs that
are about to disappear. Run the media migration first, or pass `--allow-legacy`
if you have a reason to publish anyway.

### Rotate the Notion token

1. Notion → Settings → Connections → Develop or manage integrations → the
   testimonials integration → **Rotate secret**.
2. Confirm the integration is still connected to the Testimonials database.
3. Re-export it in your shell: `read -rs NOTION_TOKEN && export NOTION_TOKEN`
4. Verify: `npm run publish:dry` should report 52 rows read.
5. Revoke the old secret in Notion.

Nothing in this repository stores the token, so there is no file to update and
no deploy to trigger. If a token is ever exposed, rotate first and investigate
second.

### Roll back the widget

The widget is a single file. Every rollback is a git operation plus a paste.

- **Squarespace shows something wrong:** edit the code block and paste the
  previous version of `widgets/wall-of-love.html`
  (`git log --oneline -- widgets/wall-of-love.html`, then
  `git show <sha>:widgets/wall-of-love.html`).
- **Emergency:** delete the code block's contents, or re-enable the
  testimonial.to embed. The testimonial.to embeds have not been removed, so
  this is available until you choose to remove them.
- **Bad feed rather than bad widget:** `git revert` the commit that changed
  `testimonials/approved.json` and push. The widget picks up the previous feed
  within the hour, or immediately in a hard refresh.

### Roll back the media migration

Only relevant after `--apply` has repointed Notion.

1. Take `.migration/media-manifest.json` from the run you want to undo.
2. For each entry with `status: "migrated"`, set the Notion page's `Avatar URL`
   or `Attached Images` back to `originalUrl`.
3. This only works while testimonial.to is still active. **Once the
   subscription is cancelled the original URLs are dead and rolling back to
   them restores broken images.** After cancellation the rescued assets in
   `img/testimonials/` are the only copies that exist.

Rolling back the *assets* is different and always safe: they are committed
files, so `git revert` removes them and `git revert` of that restores them.

### Verify no testimonial.to URLs remain

```bash
# 1. The published feed
curl -s https://media.jamesgunaca.com/testimonials/approved.json \
  | grep -Eic 'testimonial\.to|testimonialto\.appspot|firebasestorage'   # expect 0

# 2. Notion itself (needs NOTION_TOKEN); the publisher refuses to publish
#    legacy URLs, so a clean dry run is the check
cd tools/testimonials && npm run publish:dry

# 3. Every rescued asset actually serves
node -e "
const m = require('../../testimonials/media-manifest.json');
Promise.all(m.assets.filter(a => a.newUrl).map(async a => {
  const r = await fetch(a.newUrl, { headers: { Range: 'bytes=0-63' } });
  return r.ok ? null : a.newUrl + ' -> ' + r.status;
})).then(rs => {
  const bad = rs.filter(Boolean);
  console.log(bad.length ? 'UNREACHABLE:\n' + bad.join('\n') : 'all assets reachable');
});"
```

Note that step 1 only covers *approved* rows. A row still in `New` can hold a
testimonial.to URL without it being visible in the feed.

### Verify each photo is the right person

```bash
cd tools/testimonials && npm run verify:mapping
```

The machine check proves the mapping is internally consistent: filenames derive
from the Migration Key, so a file cannot belong to a row other than the one it
came from. It cannot prove testimonial.to's export was itself correct, so the
command also writes `.migration/mapping-proof.html`, a contact sheet of every
avatar and screenshot beside its person's name. Open it and check the faces.
Last run: 34 expected, 34 present, 0 unresolved, 0 orphans, 0 shared.

---

## Testing

```bash
cd tools/testimonials && npm test          # 25 unit tests, no network
npx --yes http-server ../.. -p 8099 &      # then, from the repo root:
node widgets/test/browser.test.mjs         # 45 browser checks, headless Chromium
```

Unit tests cover filtering (approved-only, consent-only and archived rows all
excluded), ordering (featured first, date descending, undated last,
deterministic tie-break), missing optional fields, malicious HTML, private-field
leakage, schema validation and asset-URL classification.

Browser checks cover initial render, Load more (including that the feed is
fetched exactly once), keyboard operation and focus management, the loading,
empty and failed-network states, mobile layout at 390px, CSS containment, and
that markup in a testimonial cannot execute.

`widgets/fixtures/preview-feed.json` deliberately contains a record with
`<script>` tags, a `javascript:` avatar URL and a `javascript:` social link.
The preview page asserts these stay inert and shows a pass/fail banner.

### Local preview

```bash
npx --yes http-server . -p 8099
# open http://127.0.0.1:8099/widgets/preview.html
```

Five scenarios: the full wall, a homepage teaser, empty results, a failed
network, and a theme override. Resize the window to check mobile. The preview
loads the real widget file, so what you see is what gets pasted.

---

## Maintenance and troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Widget shows "No testimonials to show just yet" | Nothing is both approved and consented | Set `Status = Approved for Use` in Notion, then republish |
| Widget shows the error state | Feed 404s, or JSON is malformed | `curl -i https://media.jamesgunaca.com/testimonials/approved.json`. A 404 usually means the publish was never pushed, or Pages has not deployed yet |
| A testimonial is missing from the wall | Approved but consent unchecked, or vice versa | Check both fields; the publisher's summary prints each count separately |
| Moderation change not visible on the site | The feed is cached for up to an hour | Republish and push; or hard-refresh. `data-cache-busting="always"` disables caching for debugging |
| Notion calls return 404 | Integration not shared with the database | Notion → database → Connections → add the integration |
| Notion calls return 401 | Token wrong, expired or unset | Re-export `NOTION_TOKEN`; rotate if unsure |
| Notion calls return 429 | Rate limited | The client already throttles to ~3 req/s and honours `Retry-After`. Just rerun |
| An asset 404s on media.jamesgunaca.com | Committed but not pushed, or Pages not deployed | `git push`, wait, retry. `--apply` refuses to repoint Notion at an unreachable URL, so Notion stays correct |
| Widget CSS looks wrong on Squarespace only | A Squarespace rule is winning on specificity | Every widget selector is scoped under `.jg-wol`; raise specificity there rather than adding a global override |
| Fonts differ from the rest of the site | Squarespace's font names are versioned and can change | Update `--jg-wol-font-head` / `--jg-wol-font-body` in the widget's CSS |

### Adding a new testimonial

Navi's Notion form handles intake. Nothing here needs to change: set
`Status = Approved for Use` and tick `Consent to Publish`, then republish. New
rows get a Migration Key from the form; a row without one is skipped by the
publisher, since the id derives from it.

### If testimonial.to has already been cancelled

The 34 rescued assets in `img/testimonials/` are the only surviving copies.
Do not `git revert` the rescue commit, and do not roll back the media
migration. If a row still points at a testimonial.to URL at that point, its
image is gone and the field should be cleared rather than repointed.

---

## Files

| Path | What it is |
|---|---|
| `tools/testimonials/migrate-media.mjs` | Phase 2 — media rescue CLI |
| `tools/testimonials/publish-json.mjs` | Phase 3 — feed publisher CLI |
| `tools/testimonials/verify-mapping.mjs` | Checks every asset maps to one person; writes the proof sheet |
| `tools/testimonials/lib/notion.mjs` | Notion client: 2025-09-03 data-source endpoints, pagination, throttling, backoff |
| `tools/testimonials/lib/rows.mjs` | Row normalisation, public allowlist, ordering, id derivation |
| `tools/testimonials/lib/assets.mjs` | Asset discovery, download, validation, naming |
| `tools/testimonials/lib/validate.mjs` | Vendored JSON Schema validator |
| `tools/testimonials/lib/atomic.mjs` | Atomic writes |
| `tools/testimonials/schema/` | Feed schema |
| `tools/testimonials/test/` | Unit tests and fixtures |
| `widgets/wall-of-love.html` | **The file to paste into Squarespace** |
| `widgets/preview.html` | Local preview harness |
| `widgets/test/browser.test.mjs` | Browser checks |
| `img/testimonials/` | Rescued media |
| `testimonials/approved.json` | The published feed |
| `testimonials/media-manifest.json` | Redacted migration manifest |
| `.migration/` | Full manifest. Git-ignored, contains credentials |
