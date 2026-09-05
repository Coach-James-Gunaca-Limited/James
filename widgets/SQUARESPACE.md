# Putting the Wall of Love on Squarespace

**Nothing here has been done for you.** No Squarespace page has been changed and
the testimonial.to embeds are still in place. This is the manual checklist.

## The one file you paste

```
widgets/wall-of-love.html
```

That is the whole widget: markup, styles and script in one file. Paste the
entire contents, including the `<style>` and `<script>` tags. Do not paste
`preview.html` — that is a local test harness and will not work on the site.

## Before you paste

Confirm the feed is live and non-empty:

```
https://media.jamesgunaca.com/testimonials/approved.json
```

If `"count": 0`, the wall will correctly show *"No testimonials to show just
yet"*. Approve some testimonials in Notion and republish before going live.

## /testimonials — the full wall

1. Edit the page → add a **Code** block where the testimonial.to embed sits.
2. Paste all of `widgets/wall-of-love.html`.
3. Leave the mount as-is:
   ```html
   <div data-jg-wol data-initial="24" data-batch="12"></div>
   ```
4. Save and preview. **Leave the existing testimonial.to embed in place** until
   you are happy, then remove it in a separate edit.

## Homepage — a shorter teaser

Same file, different numbers. Change only the mount line:

```html
<div data-jg-wol data-initial="6" data-batch="6"></div>
```

Everything else stays identical. The two blocks do not conflict; each reads its
own attributes.

## Options on the mount element

| Attribute | Default | What it does |
|---|---|---|
| `data-initial` | `24` | Cards shown before any Load more |
| `data-batch` | `12` | Cards revealed per Load more press |
| `data-endpoint` | the live feed | Point at a different JSON file |
| `data-label` | "What people say…" | The section's accessible name |
| `data-cache-busting` | `hourly` | `hourly`, `none`, or `always` (debugging) |

Site-wide defaults, and theme colours, can be set in a block **above** the
widget:

```html
<script>
  window.JG_WOL_CONFIG = {
    initialCount: 12,
    theme: { accent: '#1B2CC2', radius: '14px', minCardWidth: '300px' }
  };
</script>
```

Themeable keys: `accent`, `text`, `muted`, `surface`, `page`, `border`,
`radius`, `gap`, `minCardWidth`, `fontHeading`, `fontBody`.

## Checks after pasting

- [ ] Cards render, and the count matches `data-initial`
- [ ] **Load more** appears, reveals the next batch, and disappears at the end
- [ ] Names, roles and companies look right; cards missing a role or company
      still look intentional
- [ ] Avatars load; ones without an avatar show a lettered circle
- [ ] Tab through with the keyboard: the focus ring is visible on Load more and
      on any Show more control
- [ ] Check on a phone: one column, no sideways scrolling
- [ ] Confirm the rest of the page still looks normal — the widget's CSS is
      scoped to `.jg-wol`, but this is the check that proves it

## If it goes wrong

Delete the code block's contents, or re-enable the testimonial.to embed. Then
see the rollback section in `tools/testimonials/README.md`.

## Squarespace-specific notes

- **Caching.** Squarespace may cache the page, and the feed itself is cached for
  up to an hour. After approving a testimonial, republish the feed, then hard
  refresh. `data-cache-busting="always"` bypasses caching while you are testing.
- **AJAX page transitions.** Some Squarespace templates swap pages without a
  full reload, which can leave the widget unmounted. If that happens, call
  `window.JgWallOfLove.init()` after the transition; it is safe to call
  repeatedly and skips blocks that are already mounted.
- **Fonts.** The widget asks for the site's own font families
  (`nohemi-3qocai`, `plus-jakarta-sans-rdo6u5`) with fallbacks, so it inherits
  the site's typography automatically. Those names are versioned by Squarespace
  and can change if the site's fonts are reconfigured; update
  `--jg-wol-font-head` / `--jg-wol-font-body` in the widget's CSS if so.
- **Do not** paste the widget into Settings → Advanced → Code Injection. It is a
  page-level block, and injecting it site-wide would mount it on every page.
