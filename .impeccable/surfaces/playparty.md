<!-- impeccable:surface-schema 1 -->

Primary target: src/App.tsx
Related targets: src/Library.tsx, src/Player.tsx, src/Call.tsx, src/style.css
Mode: Operate
Scope: Name-only arrival, the shared call, owner content picker, shared player.
Execution: code-led. The user pinned a minimal dark call interface and approved a simplified Plex library picker; this existing approval controls the build.

## Direction contract

THESIS: A private movie night. The media and faces fill the screen; everything else earns its space.

OWN-WORLD: Near-black graphite, soft off-white Geist, quiet gray controls, restrained green presence, red only for leaving. Native dialogs and real Plex posters.

STORY: Enter a name, see your friends, watch the host’s choice. The owner searches an existing library and chooses a poster.

FIRST VIEWPORT: Small wordmark above a centered 390px name form. Joined desktop: film occupies the wide stage, faces sit beside it, and call controls sit below. Phone portrait: movie and camera strip form a centered group with a 14px gap, with call actions at the bottom. Phone landscape: movie covers the viewport, small horizontal faces sit at the lower left, device actions sit at the upper right, and hang-up and picker sit at the lower right. The picker is a compact poster grid with one search.

FORM: Brief-pinned dark screening room; seed 97ab6115 acknowledged. The user’s pinned aesthetic outranks alternate forms. Signature interaction: choosing a poster starts everyone on a shared clock. Controls fade while watching; interface state transitions stay under 200ms.

FINISH: Reviewed and documented on 2026-10-13. All five finish-review sections were valid; disposition: ship. Root DESIGN.md and .impeccable/design.json reflect the built source. The shipping public screenshot has provenance in docs/screenshots/README.md.

## Built behavior

- Desktop regular viewing keeps its side rail. Whole-app desktop fullscreen places faces at the bottom center, up to 237×180px per tile, with call controls below.
- Portrait phones keep the movie and call strip centered with a tight 14px gap and footer actions at the bottom.
- Phone landscape, through 1100px width and 600px height, uses edge-to-edge cover movie framing without safe-area padding. Horizontal 16:10 faces sit 12px from the lower left, capped at 64px high and scaled for up to five people.
- In phone landscape, 44px microphone and camera buttons stack 12px from the upper right. The 44px hang-up action sits 12px from the lower right; the host movie picker sits directly above it. The middle of the right edge remains clear for the Dynamic Island area. Movie controls sit above the faces.
- Fullscreen requests the whole app, with a fixed viewport fallback if native fullscreen is unavailable. Both modes preserve the phone landscape composition.
- Playback chrome fades after 2.6 seconds while playing. Pointer movement, pointer press, and keyboard focus restore it; focused and paused controls stay visible.
- Camera and microphone are requested together on joining. Movie changes keep the call tracks connected. Permission and connection failures use concise dismissible notices.
- Speech lowers movie audio to 30% of its baseline when volume is writable; fixed-volume browsers temporarily mute only the movie. Loading waits for every participant rather than advancing on a forced timeout.
- Inline movie and call video suppress native controls and picture-in-picture where supported. Physical Safari behavior has not been certified.
- The name-only guest path and owner switch are retained. Standalone host sign-in uses Plex by default; an optional external provider can replace it. No deployment-specific account data belongs in the surface brief.

## Finish evidence

The finish reviewer checked the loaded implementation at desktop 1440×900, portrait phone 390×844, and landscape phone 852×393. These temporary review captures used the real UI with explicit fictional cat media and participant fixtures. They support layout review, not an assertion that physical iPhone Safari was tested. Temporary captures are removed after documentation.

The public README screenshot also uses fictional cat media and participants. Its generation prompts and capture provenance live in `docs/screenshots/README.md`. Runtime movie artwork and metadata come from the configured Plex library.

The pinned minimal dark direction and existing self-hosted Geist remain the design authority. The sanctioned `overused-font` exception in `.impeccable/config.json` records that choice.
