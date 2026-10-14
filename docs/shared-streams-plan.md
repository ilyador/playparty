# Shared Plex output plan

Proposed work, not implemented. Reuse one normal Plex HLS session for viewers requesting the same output. This reduces duplicate conversion work; each viewer still receives a separate HTTP stream, so home upload usage stays the same. [P2P delivery](p2p-plan.md) is a separate, later optimization.

## Implementation

1. **Prove reuse against real Plex first.** Create an isolated HLS session with one stable client identity, session ID, profile and start offset. Let two readers consume its playlists and segments. Check identical segment bytes, one transcode session, late joining and long pause/resume, including recovery after Plex expires an idle session. Seek by creating a new session. Stop only the test session afterward. Plex documents its ordinary playback endpoints; multi-viewer reuse remains a behavior we must prove. [Plex API](https://developer.plex.tv/pms/)

2. **Keep ownership in `server/plex.mjs`.** Retain the viewer-to-stream map and add an output-key-to-producer map. Each producer owns its Plex session, stable upstream client identity, rewritten resources, attached viewers and startup promise. Concurrent matching requests await the same promise. Give every actual producer instance an opaque output ID, including replacements after failure.

3. **Share exact profiles only.** Build the key from movie, existing `mediaVersion`, effective codec profile, LAN/WAN policy, bitrate, resolution, audio settings and subtitle ID/mode. Include text subtitles: Plex currently packages them into the session's playlists. Freeze the producer's starting offset once; late joiners use its timeline and the existing playback clock. Different quality or subtitle choices get separate producers. Local original-quality behavior stays intact.

4. **Attach safely through the existing endpoints.** `/api/playback` acquires a matching producer before releasing the viewer's previous assignment. Reacquiring the current producer reuses its assignment without releasing it; otherwise release only the captured previous assignment. Recheck membership and movie version before committing. Stale completions release their captured assignment, never a newer one. `/api/stream/:resource` keeps membership and assigned-output checks, stable rewritten URLs and credential stripping; upstream requests use the producer's identity. Each HTTP response keeps its own cancellation. Plex remains responsible for the HLS chunks; no Node media cache is needed.

5. **Reuse current cleanup and playback behavior.** Refresh, departure or a profile change releases one viewer. Stop Plex when no assignments remain, preserving existing disconnect grace. Movie changes, host seeks and Stop retire old generations and drain pending startups. A failed producer is retired once; affected viewers reacquire through existing recovery. Preserve adaptive quality, sync, readiness, upload limits and the single progress writer. Plex will report shared output sessions rather than every viewer.

## Acceptance gate

Extend the existing adapter/lifecycle tests, then verify with real Plex and browsers:

- Five matching viewers use one producer; a different quality or subtitle selection uses another. This is a test case, not a participant limit.
- Simultaneous joins, sole-viewer refresh, departure, expiry and stale startup callbacks neither duplicate nor accidentally stop a producer.
- Late join, long pause, refresh, failure recovery and rapid host seeks preserve decoded playback and the existing sync recovery bounds.
- Unauthorized resource access fails; the last viewer and an empty party leave no Plex sessions or resource mappings.

Proceed only after the real-Plex proof passes. The change lives in the current adapter and proxy: no Plex patches, extra service, database, persistent cache, subtitle extraction, new quality ladder, sync system or UI controls.
