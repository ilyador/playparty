---
name: Playparty
description: A private screening room for a movie and your people.
colors:
  canvas: "#101113"
  foreground: "#eeefec"
  raised: "#25282d"
  muted: "#a5aab2"
  field: "#191b1f"
  action: "#e9eae5"
  action-text: "#16181a"
  leave: "#b74543"
typography:
  headline:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(32px, 3.7vw, 44px)"
    fontWeight: 550
    lineHeight: 1.15
    letterSpacing: "-.035em"
  title:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-.025em"
  body:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "Geist Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  dialog: "16px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  stage: "32px"
  frame: "40px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.md}"
    padding: "0 17px"
    height: "52px"
    width: "100%"
  button-call:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    size: "50px"
  button-leave:
    backgroundColor: "{colors.leave}"
    rounded: "{rounded.lg}"
    width: "66px"
    height: "50px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    size: "40px"
  input-name:
    backgroundColor: "{colors.field}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "54px"
    width: "100%"
  dialog-library:
    backgroundColor: "{colors.field}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.dialog}"
---

# Design System: Playparty

## Overview

**Creative North Star: "The Private Screening Room"**

Near-black graphite surrounds the movie and faces. Soft off-white Geist keeps the interface legible without competing with media. The room feels quiet and personal: a small wordmark, short labels, and controls that earn their space.

The shipped interface uses one type family, restrained rounded rectangles, real Plex artwork, and functional Phosphor icons. Its density comes from the people and library content. It does not add decorative panels or a marketing layer around the call.

The app icon pairs two chalk and muted-sage companion forms around a shared play-shaped opening on opaque graphite. Its simple, centered silhouette carries the room's identity onto the Home Screen and browser tab.

The name form includes an “I am the host” switch below the name field only when the machine running Playparty can access its configured Plex library. Its full label row is at least 44px high, with a 44×26px track and a 20px soft-white thumb. Off uses field-border gray; on uses the room’s quiet green. Keyboard focus outlines the track, and changes take 160ms. The switch starts off and stays completely hidden until access is verified, including when Plex is offline. Standalone hosting requires no browser Plex sign-in or email check. A configured external provider also requires an authenticated session. The switch selects the role rather than granting permission.

**Key Characteristics:**
- Graphite surfaces with soft off-white text.
- Movie and camera imagery establish the visual hierarchy.
- Compact controls and short, sentence-case labels.
- Brief state transitions; playback chrome recedes during viewing.

## Colors

The palette is mostly neutral; pale actions, quiet green presence, and a red leave control communicate specific states.

### Primary
- **Soft Chalk** (`action`): the name form's Join button, with dark `action-text` lettering.
- **Leave Red** (`leave`): the disconnect control. It is a functional warning color, not a general emphasis color.

### Neutral
- **Graphite Canvas** (`canvas`): the full application background.
- **Soft White** (`foreground`): main text, icons, caret, and keyboard focus outlines.
- **Raised Graphite** (`raised`): microphone and camera buttons; the mobile picker action.
- **Quiet Gray** (`muted`): supporting copy and footer metadata.
- **Field Graphite** (`field`): the name field and library dialog.

**The Functional Color Rule.** Keep interface color tied to an action or state. Artwork supplies the room's color; its hues do not become interface accents.

## Typography

**Display and Body Font:** Self-hosted Geist Variable, with the platform sans-serif fallbacks recorded above. Geist is the user-approved incumbent face and has a sanctioned detector exception in `.impeccable/config.json`. There is no separate display or mono family.

**Character:** Moderate variable weights and slightly tight headings create a calm, compact interface. Headings are larger than labels without turning the room into a promotional page.

### Hierarchy
- **Headline:** the arrival heading uses the fluid headline token; mobile fixes it at 34px. Waiting headings use a smaller 25–38px range and weight 480.
- **Title:** the library heading uses the title token, reduced to 21px on mobile.
- **Body:** short waiting-state explanations use the body token. Name entry and the Join button use 15px text; the button weight is 550.
- **Label:** field labels and secondary actions use compact 13px text. Labels stay in sentence case.
- **Caption:** participant names, time, and footer metadata use 12px text. Participant captions reduce to 11px on mobile. Playback time uses tabular numerals.

**The One Family Rule.** Use Geist throughout the interface. Distinguish hierarchy through size, weight, spacing, and color rather than another display face.

## Layout

The shell is a viewport-height grid with a header, flexible stage, and footer. Desktop uses an 80px header, 32px stage gutters, and a footer of at least 108px. The arrival form is at most 390px wide. When an active movie is shown beside arrival, the form and artwork form two columns within a 1040px container.

During ordinary desktop viewing, the movie occupies the wide column and faces occupy a 208px side rail with an 18px gap. At 1700px and above the rail becomes 256px. At 900px and below, faces move beneath the movie into a horizontal 130px strip. At 600px and below, 12px stage gutters surround a vertically centered movie-and-call group, with a tight 14px gap. The 100px-high camera strip uses 140px-wide tiles and scrolls horizontally as needed. The phone footer keeps call controls and the host picker at the bottom, with safe-area padding.

Phone landscape is a separate viewing composition, active in landscape at up to 1100px wide and 600px high. The movie covers the full viewport edge to edge, without a safe-area inset or rounded corners; cover fitting can crop its edges. Horizontal 16:10 call tiles sit 12px from the bottom and left. Their height is the smallest of 64px, 17dvh, and the available width divided across the current participants. Tile gaps are 8px, and their row reserves space for the right-hand actions.

In that landscape composition, microphone and camera are stacked at the upper right, 12px from the edges. Hang-up sits at the lower right, with the host movie picker directly above it. All four actions are 44px squares. The center of the right edge stays clear for the Dynamic Island area. A full-width bottom gradient supports the movie controls. The seek interaction sits above the faces and ends 72px before the right edge; its left edge respects the safe area. Transport controls share the lower row beside one to three faces. With four or more faces, transport moves into a row above them and seek moves one row higher. Seek and icon actions retain 44px interaction heights.

Whole-app fullscreen keeps the movie and call together. Desktop faces form a vertical stack 16px from the top and right edges. Each tile is at most 237px wide with a 16:10 aspect ratio; tile width adapts to viewport height and the current participant count, using 8px gaps and a 96px height reserve. Call controls remain bottom centered, 8px from the edge. Narrow portrait fullscreen places the face row above the call controls and movie controls. Phone landscape preserves its lower-left face row and split right-side actions in both native fullscreen and the viewport fallback.

The library poster grid has six columns on desktop, five below 900px, and three below 600px. Mobile search fills the dialog width and sits above the type filters. The dialog scrolls its results while its heading and tools remain in their own grid rows.

Small gaps follow the recorded spacing steps; larger values frame the stage rather than creating nested panels. There is no fixed participant limit. Larger lobby calls use three columns on desktop and two on phones, adding equal-height grid rows; movie call tiles adapt to the current participant count.

## Elevation & Depth

The room is mostly flat. Tonal surfaces, clipped media, and translucent caption gradients establish depth. Shadows are reserved for the native modal and transient notices: the library uses `0 28px 80px rgba(0,0,0,.55)` and the notice uses `0 12px 32px rgba(0,0,0,.4)`. The native dialog backdrop darkens the surrounding room with `rgba(5,6,8,.72)`.

**The Media Depth Rule.** Use gradients where captions or controls overlap imagery. Use tonal contrast for ordinary controls and shadow for overlays that sit above the room.

## Shapes

Controls and fields use softly rounded rectangles. Small icon controls and search use the small radius; arrival controls use the medium radius; camera tiles, the desktop player, and call controls use the large radius. The library has the larger dialog radius, reduced to 14px on mobile. Portrait phone call controls use the medium radius and the player uses 9px corners. Phone landscape uses 9px corners on call controls and tiles, while its edge-to-edge movie has no radius.

Posters keep their native 2:3 silhouette, with 8px corners on desktop and 6px on mobile. Camera imagery is clipped inside its tile; initials and presence indicators are circular. Borders are thin and quiet rather than framing every surface.

The app icon is a full-bleed opaque square with no baked corner mask. Its essential symbol stays inside the central safe area so the platform can apply its own rounded or circular mask.

## Components

### App Icon

Use the shipped companion/play artwork from `public/icons/`. Warm chalk and muted sage belong to the icon; its graphite background matches the room. The mark has no text, decorative ring, or outer shadow. The 180px Apple touch icon, 32px favicon, and 192px / 512px manifest variants share the same artwork. Exact generation provenance is recorded in `public/icons/README.md`.

### Buttons

Pale arrival actions lead into the room; graphite controls operate within it. The Join button fills the form, uses 15px text at weight 550, and aligns its label and Phosphor arrow to opposite sides. Secondary actions use a compact dark fill, 8px corners, and at least 44px height. Icon buttons are 40px squares.

All buttons use a brief pressed scale (`.97`). Fine-pointer hover changes the background; keyboard focus uses a 2px soft-white outline with 4px offset. Disabled buttons reduce opacity to `.45`. State transitions take 120–180ms with the shared easing curve. Reduced-motion preferences suppress these transitions and the functional spinner animation.

### Inputs / Fields

The arrival screen has one visible name label and one full-width field. Its 54px height, 16px horizontal inset, and quiet one-pixel border give text comfortable room. The field changes border color on focus and retains the global keyboard outline.

Library search is a compact bordered field with a Phosphor magnifier. Its focus outline surrounds the whole field, with a 3px offset. Search height increases from 40px to 44px on mobile and its text increases to 16px.

### Library Picker

The picker is a native modal dialog populated by real Plex posters and metadata. Filter buttons use a quiet filled selected state. Poster titles clamp to two lines; supporting year and duration remain muted. Hover and keyboard focus reveal the poster's action overlay. Shows and seasons lead deeper into the same picker; episodes become compact divided rows.

The dialog closes through its close control, Escape, or backdrop. The host's footer picker button carries an explicit accessible name even when its text is hidden on mobile.

### Camera Tiles

Camera video fills a rounded tile. A bottom gradient holds the name and device-state icons; the local camera is mirrored. When video is absent, initials occupy a centered circle. Tile size and initials scale with the call layout; names truncate before they collide with state indicators.

### Call Controls

Microphone, camera, and leave are the three persistent call controls. Desktop device buttons are 50px squares; leave is wider at 66px. Desktop fullscreen reduces device buttons to 40px squares and leave to 46px wide. Portrait phone device buttons are 46px squares and leave is 54px wide. Phone landscape uses 44px squares in the split right-side arrangement recorded in Layout. Off devices use a lighter graphite state. Icons have accessible labels, and microphone/camera expose their pressed state. Joining requests camera and microphone together; if access fails, a short notice points to the device buttons. Changing movies keeps the call and its device tracks connected.

Microphone and camera controls stay disabled until the initial connection and capture request settle. The microphone button reflects the published native track's live, enabled, and unmuted state. A stopped track produces a quiet notice and tapping the mic button requests recovery. Capture retries serialize acquisition and publication, replacing interrupted tracks without a duplicate microphone; acquired and pending tracks remain owned through cleanup when leaving. When browser policy blocks remote call audio, the existing notice offers “Enable call audio.” This source behavior does not establish that microphone permission persists across physical Safari sessions.

### Movie Player

The contained video keeps a 16:9 stage and uses letterboxing when needed. Phone landscape uses the full-viewport cover treatment recorded in Layout. Title and playback controls sit on gradients; landscape uses the full bottom gradient rather than a floating control panel. Playing controls fade after 2600ms of inactivity, using the video element's actual paused state. Pointer movement, pointer press, and focus restore them. Keyboard interaction keeps focused controls visible; pointer clicks return to timed hiding even when the clicked control retains focus. Paused media keeps its controls visible. The host can play, pause, seek, and stop; Stop returns to the picker without ending the call. Movie mute, subtitle selection, and fullscreen are compact icon controls. Subtitle selection uses native options behind the Phosphor subtitle icon, with an active filled state. Episode titles include their series name.

Fullscreen requests the whole application surface, with a viewport-filling fallback if the browser rejects native fullscreen. Escape exits the fallback when no picker dialog is open. Fullscreen text captions move above face tiles that overlap the lower half of the movie; the desktop upper-right stack retains the ordinary caption position. The movie and camera videos use inline playback with native controls, picture-in-picture, and remote playback suppressed where supported. These attributes are a best-effort browser request; physical Safari playback and its native caption engine remain unverified.

Movie audio lowers to 30% of its current baseline during speech when the browser permits volume changes, fading down over 120ms and restoring over 450ms after an 800ms silence hold. Browsers with fixed media volume temporarily mute only the movie after 300ms of sustained speech, then wait for 1200ms of silence before restoring it. The user's movie-mute choice remains in effect. Clock correction uses stable playback-rate adjustments with hysteresis to avoid repeatedly changing audio stretching during minor clock jitter.

Movie quality adapts per viewer without adding controls. Local-network viewers have no stream bitrate cap; a congested remote viewer receives a lower Plex bitrate and, when needed, a 720p or 1080p resolution cap. With HLS fragment measurements, sixty seconds of sustained healthy capacity can raise quality one step; native HLS lacks those measurements, so upward recovery is limited. The learned cap survives seeking and subtitle changes and resets for a different movie. The existing “Original video” / “Optimized video” label remains the only quality indicator.

Join synchronously calls playback on the actual movie video element within the trusted gesture, before the asynchronous join request, then pauses it for the shared clock. That same element is reused across stream, subtitle, movie, and leave/rejoin changes within the page. A genuine autoplay denial holds the shared clock until the viewer uses the normal compact “Start playback” icon or taps the movie. Recovery uses the existing controls without an extra gesture overlay. Source-generation and shared-pause guards reject stale autoplay failures and prevent a resolved play attempt from continuing after the party pauses. Stale playing events are ignored while the element is actually paused or ended.

Loading and synchronization messages stay inside the media area; the shared movie waits for every participant to be ready rather than advancing on a forced timeout. Reconnected event sockets require fresh readiness checks and ignore callbacks from older sockets. Readiness resets for each buffering cycle and source reload. A seek that remains unfinished for 1.5 seconds holds the shared clock; after 8 seconds, available buffered data permits reloading only the affected source. End of movie stays paused until the host explicitly presses Play to replay. Native playback errors offer Reconnect; HLS media errors receive at most two recovery attempts before the same error action. These safeguards do not establish physical iOS playback certification.

The lobby artwork gives the series name the main title role, with the episode title below it and a quieter season/episode line. Long titles clamp to two lines. The picker adds a Continue filter when Plex supplies continue-watching items; a quiet progress line and Resume time identify partially watched titles without adding another dialog.

Poster buttons stack their content from the top, with a two-line title slot and a consistent metadata row. Compact season/episode labels keep that row readable on mobile. Extra resume text never shifts neighboring artwork or titles vertically.

The seek track is visually 3px high, inside a 24px desktop interaction area and 44px phone interaction area. Its position label is explicit, and time uses tabular numerals.

## Do's and Don'ts

### Do:
- **Do** keep the movie and people ahead of persistent interface chrome.
- **Do** use self-hosted Geist and functional Phosphor icons.
- **Do** use real Plex artwork and metadata in the library.
- **Do** keep keyboard focus visible and icon actions explicitly named.
- **Do** preserve the desktop fullscreen upper-right face stack, portrait camera strip, landscape lower-left face row, and phone seek control's 44px interaction height.
- **Do** keep phone landscape controls out of the center of the right edge.

### Don't:
- **Don't** use poster colors as permanent interface accents.
- **Don't** apply the modal shadow to ordinary controls or camera tiles.
- **Don't** add decorative panels or marketing typography around the room.
- **Don't** let pointer-focused playback controls stay visible after the inactivity timer; keyboard-focused controls remain available.
