<!-- impeccable:surface-schema 1 -->

Primary target: src/App.tsx
Related targets: src/Library.tsx, src/Player.tsx, src/Call.tsx, src/style.css
Mode: Operate
Scope: Name-only arrival, the shared call, host content picker, shared player.
Execution: code-led. The user pinned a minimal dark call interface and approved a simplified Plex library picker; this existing approval controls the build.

## Direction contract

THESIS: A private movie night. The media and faces fill the screen; everything else earns its space.

OWN-WORLD: Near-black graphite, soft off-white Geist, quiet gray controls, restrained green presence, red only for leaving. Native dialogs and real Plex posters.

STORY: Enter a name, see your friends, watch the host’s choice. The host searches an existing library and chooses a poster.

FIRST VIEWPORT: Small wordmark above a centered 390px name form. Joined desktop: film occupies the wide stage, faces sit beside it, and call controls sit below. Desktop fullscreen: faces stack at the upper right, with call actions bottom centered. Phone portrait: movie and camera strip form a centered group with a 14px gap, with call actions at the bottom. Phone landscape: movie covers the viewport, small horizontal faces sit at the lower left, device actions sit at the upper right, and hang-up and picker sit at the lower right. The picker is a compact poster grid with one search.

FORM: Brief-pinned dark screening room; seed 97ab6115 acknowledged. The user’s pinned aesthetic outranks alternate forms. Signature interaction: choosing a poster starts everyone on a shared clock. Controls fade while watching; interface state transitions stay under 200ms.

FINISH: Fresh finish review on 2026-10-13 accepted all five contract sections; disposition: ship, with no material UI fixes. Documentation was refreshed afterward to capture the reviewed source and latest user-pinned desktop fullscreen placement. Earlier stale prose was a documentation handoff, not a UI defect. Root DESIGN.md and .impeccable/design.json reflect the built source. The public screenshot has provenance in docs/screenshots/README.md.

## Built behavior

- There is no fixed participant limit. Larger lobby calls use three desktop columns or two phone columns with automatically added equal-height rows. Movie call tiles scale with the current participant count.
- Desktop regular viewing keeps its side rail. Whole-app desktop fullscreen places a vertical face stack 16px from the top and right. Tiles are at most 237px wide with a 16:10 aspect ratio; viewport-height adaptation uses the current participant count, 8px gaps, and a 96px reserve. Call controls remain bottom centered. This latest user-pinned placement supersedes the former bottom-centered face row.
- Portrait phones keep the movie and call strip centered with a tight 14px gap and footer actions at the bottom.
- Phone landscape, through 1100px width and 600px height, uses edge-to-edge cover movie framing without safe-area padding. Horizontal 16:10 faces sit 12px from the lower left, capped at 64px high and scaled for the current participant count.
- In phone landscape, 44px microphone and camera buttons stack 12px from the upper right. The 44px hang-up action sits 12px from the lower right; the host movie picker sits directly above it. The middle of the right edge remains clear for the Dynamic Island area. A full-width bottom gradient supports movie controls. Seek sits above faces and respects the left safe area; transport sits beside one to three faces, then moves into a row above four or more faces, with seek one row higher. Both seek and movie icons retain 44px touch targets.
- Fullscreen requests the whole app, with a fixed viewport fallback if native fullscreen is unavailable. Both modes preserve the phone landscape composition.
- Playback chrome fades after 2.6 seconds while the actual video element is playing. Pointer movement, pointer press, and focus restore it. Keyboard-focused controls and paused media stay visible; pointer-click focus does not keep chrome open after the timer.
- Join synchronously calls playback on the actual movie video element before the asynchronous join request, then pauses it for the shared clock. The element is reused across stream, subtitle, movie, and leave/rejoin changes within the page. Genuine autoplay denial holds the shared clock until the normal compact “Start playback” icon or a movie tap supplies the gesture. Recovery uses the existing controls without an extra overlay; source-generation and pause guards reject stale attempts.
- Event-socket reconnects require fresh readiness rather than replaying cached readiness, and old socket callbacks are ignored. Each buffering cycle and source reload resets readiness. A seek unfinished for 1.5 seconds holds the shared clock; after 8 seconds, available buffered data permits reloading only the affected source. Stale playing events are ignored while the element remains paused or ended.
- Camera and microphone are requested together on joining; their controls stay disabled until initial connection and capture settle. Retries serialize acquisition and publication without duplicate microphones, and acquired or pending tracks remain owned through cleanup across Leave. Movie changes keep the call tracks connected. Permission and connection failures use concise dismissible notices.
- Microphone controls reflect the native track's live, enabled, and unmuted state; a dead microphone can be recovered by tapping its button. Blocked remote call audio uses the existing quiet notice with “Enable call audio.”
- Speech lowers movie audio to 30% of its baseline when volume is writable, with 120ms down / 450ms up fades and an 800ms silence hold. Fixed-volume browsers mute only the movie after 300ms of sustained speech, restoring after 1200ms of silence. Stable playback-rate corrections use hysteresis to avoid audio flutter. Loading waits for every participant rather than advancing on a forced timeout.
- Movie quality adapts independently for each remote viewer under congestion, reducing Plex bitrate and, when needed, capping resolution at 720p or 1080p. Local-network viewers have no stream bitrate cap. HLS fragment measurements can support one upward step after 60 seconds of sustained healthy capacity; native HLS upward recovery is limited by unavailable measurements. The learned cap survives seeks and subtitle changes and resets with a new movie. The existing “Original video” / “Optimized video” label is retained; this adds no controls or layout changes.
- End of movie waits for explicit host Play to replay. Native playback errors offer Reconnect; HLS media errors receive at most two recovery attempts before the same action.
- Inline movie and call video suppress native controls and picture-in-picture where supported. Physical Safari playback, native captions, and microphone permission persistence remain unverified.
- The name-only guest path is retained. The host switch starts off and appears only after the machine running Playparty verifies access to its configured Plex library; it stays hidden when unavailable. Public guest identities are distinct from private session cookies. Standalone hosting requires no browser Plex sign-in or email match; an optional external provider additionally requires an authenticated session. With `LOCAL_AUTH=true`, a configured “Sign in to host” link opens that existing login in the same window, preserving the name and the Home Screen app's cookie store through a same-origin return. No deployment-specific account data belongs in the surface brief.
- Home Screen and browser identity use the shipped opaque graphite companion/play icon, with chalk and muted sage forms. HTML links the Apple touch icon, favicon, and manifest. The manifest launches in standalone display with root start URL and scope; no service worker is added.
- An active hosted party disables the host switch for other visitors with “There is already an active session.” as its accessible explanation. Empty-party retirement restores the unchecked switch; guests can still join an active party.

## Finish evidence

The finish reviewer checked the loaded implementation in `.impeccable/review/desktop.png` (1440×900, whole-app fullscreen viewport fallback with the upper-right face stack), `mobile.png` (390×844, portrait), and `landscape.png` (852×393). The documenter inspected those same captures against current source. They use the real UI with explicit fictional cat media and participant fixtures. They support layout review, not an assertion that physical iPhone Safari was tested. Temporary captures are removed after documentation.

The public README screenshot also uses fictional cat media and participants. Its generation prompts and capture provenance live in `docs/screenshots/README.md`. Runtime movie artwork and metadata come from the configured Plex library.

The pinned minimal dark direction and existing self-hosted Geist remain the design authority. The sanctioned `overused-font` exception in `.impeccable/config.json` records that choice.

An independent icon finish review accepted the opaque artwork, mask-safe composition, and actual 180px / 32px outputs; disposition: ship. Its exact generation prompt and artifact provenance live in `public/icons/README.md`.

Subsequent source changes refined automatic quality, speech holds, clock correction, and device/audio diagnostics without changing the reviewed layout. Device/audio diagnostic records carry state booleans, permission values, enums, and call-audio output counts.

A fresh independent playback-control finish review accepted gesture recovery through the ordinary compact play action; disposition: ship. Actual Chrome integration verified that autoplay denial holds the owner's clock and ordinary control recovery resumes it even without media events. Source and rejoin tests cover fresh readiness, guest/host leave and rejoin, full reload, transport waiting, and stuck-seek recovery. Physical iOS playback remains unverified.

The latest independent core finish review also returned ship. Real Chrome remote playback checks passed movie, captions, a 12-second delay, fullscreen, and controls. Five simultaneous camera/audio clients were a verification sample, with a sixth API participant accepted; seven native LiveKit signaling participants were accepted after removing its capacity setting. These samples establish tested scope, not a participant cap or physical iOS certification.
