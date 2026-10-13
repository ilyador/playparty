# Playparty app icon

Generated with the built-in image generation tool using the brandkit and imagegen skills. The mark pairs two companions around a shared play-shaped opening; chalk and muted sage sit on opaque graphite.

Files:
- `playparty-master-1024.png`: 1024px master artwork.
- `apple-touch-icon-180.png`: iOS Home Screen icon.
- `playparty-192.png` and `playparty-512.png`: web app manifest icons.
- `favicon-32.png`: browser favicon.

The PNGs are opaque squares without baked corner masks. Downsampling uses Pillow LANCZOS; the artwork is otherwise unchanged. Each PNG embeds the exact generation prompt as a `Generation prompt` text field.

## Generation prompt

```text
Use case: logo-brand
Asset type: final Playparty app icon for iOS Home Screen and a Safari desktop web app, a single 1024 by 1024 square raster asset.
Primary request: design one cool, quietly premium app icon for watching movies with friends. Make an original abstract Playparty symbol: two thick, gently rounded ribbon-like forms nest together around a crisp right-facing play-shaped negative space, subtly suggesting a pair of linked P forms and two people sharing a screen. The mark must feel ownable and reduced, visually readable even at favicon size.
Scene/backdrop: opaque full-bleed flat graphite (#101113), extending all the way to all four square corners.
Subject: one large centered simple geometric emblem. Dominant form in warm chalk (#E8E6E0), companion form in muted sage lime (#B8C49B). Crisp silhouette, generous 20 percent surrounding negative space, essential symbol fully within the central 70 percent. A single unified symbol with a clear shared center.
Style/medium: high-end contemporary identity design; bold vector-like contours; calm cinematic character, precise smooth edges, restrained flat colors. No texture needed.
Composition/framing: straight-on, perfectly square, the app artwork fills the entire image; no presentation board, no device frame, no mockup, no separate tile on a canvas.
Text: none.
Constraints: no letters or wordmark, no typography, no watermark, no shadows outside the symbol, no decorative rings, no glossy 3D, no generic gradient, no purple or blue glow, no film reel or clapperboard. No baked rounded outer corners; iOS and Safari apply their own masks. Opaque square background. One simple memorable centered mark.
```

## Safari and web app metadata

The HTML links the 180px Apple touch icon and web app manifest, sets the Playparty Home Screen title, and enables standalone display. The manifest uses `display: standalone`, local root scope, and icons usable with ordinary and maskable presentation. No service worker is added.

Metadata references: [Apple: Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html), [MDN: manifest icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons), [MDN: standalone display](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display).

