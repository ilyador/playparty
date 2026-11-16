# Playparty app icon

The installed icon is **Screen Cat — Ticket palette**, the original purple Screen Cat selected on 2026-10-16. Its angular television-cat silhouette uses deep plum, an ivory screen, a raspberry play symbol and folded accents, and a lavender-lilac background. It shares Locdoc and Localcam's bold origami / Linux-game style.

The unchanged generated source is [02b-screen-cat-ticket.png](../../design/icon-options/02b-screen-cat-ticket.png). It was created with built-in image editing using [Screen Cat](../../design/icon-options/02-screen-cat.png) as the edit target and [Ticket Link](../../design/icon-options/04-ticket-link.png) as the palette reference, with imagegen and brandkit guidance. The [exact edit prompt](../../design/icon-options/02b-screen-cat-ticket.prompt.txt) and [concept catalog](../../design/icon-options/README.md) preserve its provenance. The former companion icon is archived as [00-original.png](../../design/icon-options/00-original.png).

Files:

- `playparty-master-1024.png`: 1024px production master.
- `apple-touch-icon-180.png`: iOS Home Screen icon.
- `playparty-192.png` and `playparty-512.png`: ordinary web app manifest icons (`purpose: any`).
- `playparty-maskable-192.png` and `playparty-maskable-512.png`: separate maskable manifest icons (`purpose: maskable`).
- `favicon-32.png`: browser favicon.

The PNGs are opaque squares without baked corner masks. ImageMagick Lanczos resampling creates the master, Apple touch, ordinary PWA, and favicon exports directly from the selected original. The maskable pair centers the artwork at 90% scale and extends the lilac background from its edges. The source colors and geometry are preserved, and the generated source in `design/icon-options/` remains unchanged. Each exported PNG records the exact `Generation prompt`, `Source artwork` reference, and `Export treatment` in its text metadata.

## Exact color-edit prompt

```text
Use case: precise-object-edit
Asset type: Playparty Screen Cat app-icon color variant.
Primary request: Apply Ticket Link's colors to the Screen Cat design.

Input image 1 is the EDIT TARGET: the cat-shaped TV icon with lime background, dark navy body, cream screen, and cobalt play triangle and folds.
Input image 2 is the PALETTE REFERENCE ONLY: the two cinema tickets with lilac background, deep plum, warm ivory, and raspberry corners.

Change ONLY the colors of image 1. Preserve the exact cat silhouette, TV proportions, screen inset, play-triangle shape and size, ears, tail, feet, fold boundaries, position, scale, framing and margins. Do not introduce any ticket geometry.
Color mapping:
- Replace the lime background with the same lively lavender-lilac as image 2, approximately #BAA3EB, extending to every edge.
- Replace the navy cat body, outer frame, dark ear panels, tail and feet with the same deep plum ink as the front ticket in image 2, approximately #302641.
- Keep the screen warm ivory matching image 2's cream ticket and play symbol, approximately #FFF6E0.
- Replace every cobalt-blue area, including the large play triangle and the small folded faces on ears, tail tip and feet, with image 2's vivid raspberry, approximately #DF4E78.
Preserve the restrained tonal fold shading using darker shades of these base colors. Keep the broad colors clean and matte. Match the reference palette closely.
Constraints: Same design and composition; color transfer only. One opaque square icon. No added text, watermark, borders, swatches, shapes, gradients, outlines or decoration. No remaining lime, navy-blue or cobalt-blue hue.
```

## Safari and web app metadata

The HTML links the 180px Apple touch icon and web app manifest, sets the Playparty Home Screen title, and enables standalone display. The manifest preserves `/` as the app identity, start URL, and scope. Icon and manifest references use `v=screen-cat-ticket-20261016` to refresh browser assets; installed operating-system shortcuts may update on their own schedule. No service worker is added.

Metadata references: [Apple: Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications.html), [MDN: manifest icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons), [MDN: standalone display](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display).
