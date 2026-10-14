# P2P movie delivery plan

Proposed work, not implemented. After the [shared output plan](shared-streams-plan.md) passes, let compatible browsers exchange identical movie segments to reduce backend upload. The existing HTTPS stream remains available. Native HLS clients continue using HTTPS; LiveKit continues carrying only the call.

## Implementation

1. **Use the existing Hls.js path.** Add `p2p-media-loader-hlsjs` through its supported `HlsJsP2PEngine.injectMixin(Hls)` integration in `src/Player.tsx`. Preserve the native fallback and destroy the engine with the existing player teardown. Verify the chosen release against Playparty's installed Hls.js version before proceeding. [Official integration](https://github.com/Novage/p2p-media-loader/blob/main/api_documentation.md)

2. **Identify actual output generations.** Return the shared producer's opaque output ID with `/api/playback` and use it as the swarm ID. Restart, seek or changed quality, codec or subtitles gets a new ID. Only identical segment bytes and timelines may share a swarm; movie identity alone is insufficient. Keep the existing playback synchronization.

3. **Embed private discovery in the current server.** Add a small `server/p2p.mjs` adapter using `bittorrent-tracker`, with `http: false`, `udp: false`, `stats: false` and `ws: { noServer: true }`. Mount one WebSocket path through `server/index.mjs` using the supported `.ws.handleUpgrade` interface. This uses the current Node process and HTTPS port. `/events` and LiveKit signaling are different protocols. [Tracker implementation](https://github.com/webtorrent/bittorrent-tracker/blob/master/server.js)

4. **Reuse membership and cleanup.** Apply existing origin and party-cookie checks to tracker upgrades. Derive allowed infohashes from producers and manifest properties using the Node-safe helpers from `p2p-media-loader-core`, declared as a direct dependency. Use the tracker's public announce filter to recheck membership and the viewer's assigned output; reject unknown or retired hashes. Close tracker sockets on Leave/expiry and remove retired hashes. Set `announceTrackers` to this private endpoint only. No arbitrary client registration or new authentication scheme. Buffered bytes already received cannot be revoked. [Private tracker guidance](https://github.com/Novage/p2p-media-loader/blob/main/api_documentation.md#predicting-swarm-infohashes-on-a-server), [Tracker filter](https://github.com/webtorrent/bittorrent-tracker#server)

5. **Keep HTTP fallback and bound browser memory.** Under the Hls.js mixin's `p2p.core`, start with `segmentMemoryStorageLimit: 64` (MiB), `p2pDownloadTimeWindow: 16` and `httpDownloadTimeWindow: 8` (both seconds). Keep initial HTTP fallback immediate. These are trial values for the acceptance tests, not promises of savings. Use only in-memory storage. Peer departure, blocked WebRTC and tracker failure must recover through HTTPS. Feed only HTTP transfer samples into existing quality-upgrade decisions; peer/cache speed does not measure the server link. Keep buffer-based downgrades and the server upload ceiling. [Configuration definitions](https://github.com/Novage/p2p-media-loader/blob/main/packages/p2p-media-loader-core/src/types.ts), [Fallback behavior](https://github.com/Novage/p2p-media-loader/blob/main/FAQ.md)

6. **Make call quality a release gate.** The loader exposes dynamic upload-disable controls, but no documented upload bitrate cap. Test constrained uploads with an active call. If needed, use its supported `isP2PUploadDisabled` control with existing call-quality signals; verify recovery without oscillation. If that cannot protect the call simply, do not ship P2P. No custom uploader, library fork or bandwidth reservation promise.

## Acceptance gate

- Prove actual peer movie-byte transfers and reduced backend outbound bytes against the same HTTP-only baseline; a peer connection alone proves nothing.
- Repeat with active calls, slow upload/download, packet loss, no peers, blocked UDP, tracker failure and departure of the useful peer. Playback and call quality must remain stable.
- Exercise refresh, disconnect/rejoin, pause, late join, rapid seek, adaptive quality, mixed subtitles and native HLS. Check decoded frames, existing sync bounds and absence of old-generation segments.
- Reject unauthorized tracker connections and unknown/retired hashes. Empty parties must leave no tracker sockets, engines or cached segments.

One Hls.js integration and one small tracker adapter are the intended scope. No extra service or port forwards, TURN project, custom mesh, helper roles, dashboard, P2P settings UI, permanent cache or new synchronization layer.
