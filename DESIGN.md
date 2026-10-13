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

The name form includes an “I am the host” switch below the name field. Its full label row is at least 44px high, with a 44×26px track and a 20px soft-white thumb. Off uses field-border gray; on uses the room’s quiet green. Keyboard focus outlines the track, and changes take 160ms. The switch defaults on for a recognized Plex-owner login; authentication remains enforced by the server.

**Key Characteristics:**
- Graphite surfaces with soft off-white text.
- Movie and camera imagery establish the visual hierarchy.
- Compact controls and short, sentence-case labels.
- Brief state transitions; playback chrome recedes during viewing.

## Colors

The palette is mostly neutral; pale actions, quiet green presence, and a red leave control communicate specific states.

### Primary
- **Soft Chalk** (`action`): the name form's Join button and the player gesture prompt, with dark `action-text` lettering.
- **Leave Red** (`leave`): the disconnect control. It is a functional warning color, not a general emphasis color.

### Neutral
- **Graphite Canvas** (`canvas`): the full application background.
- **Soft White** (`foreground`): main text, icons, caret, and keyboard focus outlines.
- **Raised Graphite** (`raised`): microphone and camera buttons; the mobile picker action.
- **Quiet Gray** (`muted`): supporting copy and footer metadata.
- **Field Graphite** (`field`): the name field and library dialog.

**The Functional Color Rule.** Keep interface color tied to an action or state. Artwork supplies the room's color; its hues do not become interface accents.

## Typography

**Display and Body Font:** Self-hosted Geist Variable, with the platform sans-serif fallbacks recorded above. There is no separate display or mono family.

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

During viewing, the movie occupies the wide column and the camera strip occupies a 208px rail, with an 18px gap. At 1700px and above the rail becomes 256px. At 900px and below, cameras move beneath the movie into a horizontal 130px strip. At 600px and below, stage gutters become 12px and the strip is 100px high with horizontally scrolling 140px tiles. The footer hides redundant text and retains the call controls and owner picker action, with safe-area padding.

The library poster grid has six columns on desktop, five below 900px, and three below 600px. Mobile search fills the dialog width and sits above the type filters. The dialog scrolls its results while its heading and tools remain in their own grid rows.

Small gaps follow the recorded spacing steps; larger values frame the stage rather than creating nested panels. The responsive call grid supports up to five people and rearranges cameras to preserve usable video space.

## Elevation & Depth

The room is mostly flat. Tonal surfaces, clipped media, and translucent caption gradients establish depth. Shadows are reserved for the native modal and transient notices: the library uses `0 28px 80px rgba(0,0,0,.55)` and the notice uses `0 12px 32px rgba(0,0,0,.4)`. The native dialog backdrop darkens the surrounding room with `rgba(5,6,8,.72)`.

**The Media Depth Rule.** Use gradients where captions or controls overlap imagery. Use tonal contrast for ordinary controls and shadow for overlays that sit above the room.

## Shapes

Controls and fields use softly rounded rectangles. Small icon controls and search use the small radius; arrival controls use the medium radius; camera tiles, the desktop player, and call controls use the large radius. The library has the larger dialog radius, reduced to 14px on mobile. Mobile call controls use the medium radius and the player uses 9px corners.

Posters keep their native 2:3 silhouette, with 8px corners on desktop and 6px on mobile. Camera imagery is clipped inside its tile; initials and presence indicators are circular. Borders are thin and quiet rather than framing every surface.

## Components

### Buttons

Pale arrival actions lead into the room; graphite controls operate within it. The Join button fills the form, uses 15px text at weight 550, and aligns its label and Phosphor arrow to opposite sides. Secondary actions use a compact dark fill, 8px corners, and at least 44px height. Icon buttons are 40px squares.

All buttons use a brief pressed scale (`.97`). Fine-pointer hover changes the background; keyboard focus uses a 2px soft-white outline with 4px offset. Disabled buttons reduce opacity to `.45`. State transitions take 120–180ms with the shared easing curve. Reduced-motion preferences suppress these transitions and the functional spinner animation.

### Inputs / Fields

The arrival screen has one visible name label and one full-width field. Its 54px height, 16px horizontal inset, and quiet one-pixel border give text comfortable room. The field changes border color on focus and retains the global keyboard outline.

Library search is a compact bordered field with a Phosphor magnifier. Its focus outline surrounds the whole field, with a 3px offset. Search height increases from 40px to 44px on mobile and its text increases to 16px.

### Library Picker

The picker is a native modal dialog populated by real Plex posters and metadata. Filter buttons use a quiet filled selected state. Poster titles clamp to two lines; supporting year and duration remain muted. Hover and keyboard focus reveal the poster's action overlay. Shows and seasons lead deeper into the same picker; episodes become compact divided rows.

The dialog closes through its close control, Escape, or backdrop. The owner's footer picker button carries an explicit accessible name even when its text is hidden on mobile.

### Camera Tiles

Camera video fills a rounded tile. A bottom gradient holds the name and device-state icons; the local camera is mirrored. When video is absent, initials occupy a centered circle. Tile size and initials scale with the call layout; names truncate before they collide with state indicators.

### Call Controls

Microphone, camera, and leave are the three persistent call controls. Desktop device buttons are 50px squares; leave is wider at 66px. Mobile device buttons are 46px squares and leave is 54px wide. Disabled devices use a lighter graphite state. Icons have accessible labels, and microphone/camera expose their pressed state.

### Movie Player

The contained video keeps a 16:9 stage and uses letterboxing when needed. Title and playback controls sit on gradients. Playing controls fade after 2600ms of inactivity; pointer activity and keyboard focus restore them, and paused playback keeps them visible. The host can play, pause, seek, and stop; Stop returns to the picker without ending the call. Movie mute, subtitle selection, and fullscreen are compact icon controls. Subtitle selection uses the browser's native options behind the Phosphor subtitle icon, with an active filled state. Episode titles include their series name.

Fullscreen uses the application surface so the movie fills the viewport while cameras stay overlaid at the bottom center. The camera row stays within the screen on mobile, and call controls remain reachable beneath it. On narrow screens the call controls sit above the movie control row to avoid collisions.

Fullscreen camera tiles are 237×180px on desktop, scaled to fit on smaller screens. Native fullscreen is preferred; a viewport-filling mode preserves the same layout if the browser denies native fullscreen. Playing controls hide after pointer inactivity; keyboard focus keeps the relevant controls visible. Text captions move above the overlaid cameras.

The lobby artwork gives the series name the main title role, with the episode title below it and a quieter season/episode line. Long titles clamp to two lines. The picker adds a Continue filter when Plex supplies continue-watching items; a quiet progress line and Resume time identify partially watched titles without adding another dialog.

Poster buttons stack their content from the top, with a two-line title slot and a consistent metadata row. Compact season/episode labels keep that row readable on mobile. Extra resume text never shifts neighboring artwork or titles vertically.

The seek track is visually 3px high, inside a 24px desktop interaction area and 44px mobile interaction area. Its position label is explicit, and time uses tabular numerals. Loading, synchronization, gesture, and error states remain inside the media area.

## Do's and Don'ts

### Do:
- **Do** keep the movie and people ahead of persistent interface chrome.
- **Do** use self-hosted Geist and functional Phosphor icons.
- **Do** use real Plex artwork and metadata in the library.
- **Do** keep keyboard focus visible and icon actions explicitly named.
- **Do** preserve the mobile camera strip and the seek control's 44px interaction height.

### Don't:
- **Don't** use poster colors as permanent interface accents.
- **Don't** apply the modal shadow to ordinary controls or camera tiles.
- **Don't** add decorative panels or marketing typography around the room.
- **Don't** leave playback controls permanently visible while a movie is playing.
