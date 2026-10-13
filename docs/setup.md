# Setup details

[Back to Playparty](../README.md)

## Plex credentials

Use a token that can access the configured Plex server's libraries. In Plex Web, open a library item and choose **Get Info → View XML**. Copy the `X-Plex-Token` value from the XML page's address and paste it into setup's hidden token prompt. See [Plex's token instructions](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) for screenshots and details. Treat the token as a password.

On Linux, setup offers the standard Plex `Preferences.xml` location when it is readable. You can use another readable XML path or leave the path empty to enter a token. macOS setup uses the token prompt; Plex's macOS preferences are a property list rather than this Linux XML file.

Setup verifies library access directly with the selected Plex server before writing configuration. Credentials stay on the server. The `.env` and `data/livekit.yaml` files are private and setup refuses to replace existing configuration.

When the page loads, Playparty checks its configured server from the machine running the app. Use `PLEX_URL` for Plex on that machine or its network. This checks one known server; it does not scan a visitor's network. **I am the host** stays hidden until access is verified and disappears when the server is unavailable. Turn it on explicitly to host; leaving it off joins as a guest. There is no browser Plex sign-in or email match.

## LiveKit installation

The call server runs alongside Playparty when you use `npm start`; no cloud call account or Redis is required.

Linux x64 and arm64 download [LiveKit 1.13.9](https://github.com/livekit/livekit/releases/tag/v1.13.9) and verify the archive against its release checksum before extracting it. Download files are removed after installation or an extraction failure.

On macOS, setup uses LiveKit's [official Homebrew installation](https://docs.livekit.io/transport/self-hosting/local/), then copies the native server binary into the checkout's `bin/` directory. Homebrew selects the build for your Mac and verifies its package checksum; Intel Macs may build from source. LiveKit 1.13.9 or a newer 1.x release is required. If an older Homebrew version is already installed, run `brew upgrade livekit` and retry setup. LiveKit's GitHub releases do not provide macOS binary archives.

## Network access

Playparty proxies LiveKit signaling through the same HTTPS address. The app's port 5175 and LiveKit signaling port 7880 bind to loopback; your reverse proxy needs only the app upstream. Camera and microphone media use 7882/UDP, with 7881/TCP as a fallback.

If calls work locally but fail for friends, check DNS, HTTPS, router forwarding, and the server's firewall. Restrictive networks can require a [TURN server](https://docs.livekit.io/transport/self-hosting/), which the minimal setup does not include. On macOS, allow the call server through the system firewall when prompted.

## Settings

Edit `.env` and restart Playparty after changing settings.

| Setting | Purpose |
| --- | --- |
| `PUBLIC_URL` | Address people open. |
| `PLEX_URL` | Plex server address reachable from Playparty. |
| `PLEX_PREFERENCES` or `PLEX_TOKEN` | Server-side Plex credentials. |
| `AUTH_MODE` | `network` checks configured Plex access; `external` also requires an authenticated session. |
| `LOCAL_AUTH` | Show the configured external host sign-in link when `true`. Default `false`; access checks are controlled by `AUTH_MODE`. |
| `MOVIE_UPLOAD_MBPS` | Shared remote movie upload budget, default 70 Mbps. Set it below your upload speed to leave room for the call. Local viewers do not count against it. |
| `LIVEKIT_MANAGED` | Start the bundled call server with Playparty; set to `false` when running it separately. |

Plex sends compatible original video when it fits the viewer's allowance and converts for unsupported codecs, image subtitles, or bandwidth limits. Text subtitles use WebVTT. Browser support, Plex hardware acceleration, and your network determine quality. [Hardware transcoding requires Plex Pass](https://support.plex.tv/articles/115002178853-using-hardware-accelerated-streaming/); software conversion of 4K video with image subtitles can be demanding.

Playparty adjusts remote streams per viewer. Sustained slow downloads or buffering lower that viewer's Plex bitrate and resolution; a healthy connection recovers one quality step at a time. Browsers using native HLS can lower quality after repeated stalls but keep that setting until rejoining. Local network viewers keep compatible original quality. No Plex server-wide quality settings are changed. Stream replacement uses the shared buffering clock so viewers resume together.

## Existing authentication provider

The default `AUTH_MODE=network` lets anyone opening the app choose to host while the configured Plex server is accessible. To restrict host and library access through an existing login provider, set `AUTH_MODE=external`, `AUTH_URL`, and `AUTH_COOKIE_NAMES` (comma-separated cookie names) in `.env`. To show **Sign in to host** when its session is missing, also set `LOCAL_AUTH=true` and `AUTH_LOGIN_URL` to the provider's login page. The link is hidden by default. Guests still enter only their name.

iPhone Home Screen apps store their cookies separately from Safari after installation. Serve the existing provider's login page and required login endpoints under Playparty's own origin through your reverse proxy, and use a relative `AUTH_LOGIN_URL` such as `/login`. Keep the provider's successful return on that same origin. This signs into the installed app without leaving it or adding another authentication system. Ordinary browser tabs continue to share their existing login. See [WebKit's explanation of web app cookies](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps).

The server-side validation endpoint receives only the selected cookies and must return:

```json
{"authenticated": true}
```

Return HTTP 401 for expired or invalid sessions and use `Cache-Control: no-store`. Email and account-name claims are ignored. The login provider and Playparty must share the relevant cookie's domain scope. Playparty checks the provider again before library access and shared controls, alongside Plex availability. The host switch stays hidden without an authenticated session; provider failures never grant host access.

## Linux user services

The example user services in `deploy/` run the app and LiveKit separately. They expect the checkout at `~/Dev/playparty`; edit their paths if necessary. Set `LIVEKIT_MANAGED=false` before enabling them.

```sh
mkdir -p ~/.config/systemd/user
ln -s "$PWD/deploy/playparty.service" ~/.config/systemd/user/playparty.service
ln -s "$PWD/deploy/playparty-call.service" ~/.config/systemd/user/playparty-call.service
systemctl --user daemon-reload
systemctl --user enable --now playparty-call.service playparty.service
```

Use `sudo loginctl enable-linger "$USER"` to keep user services running after logout. Read logs with `journalctl --user -u playparty.service -u playparty-call.service`.

## Updates

Stop the app, then:

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

With the Linux services, use `systemctl --user restart playparty.service` instead of `npm start`. Party state resets on restart; playback progress stays in Plex. Update the LiveKit binary separately when needed.

## Playback and browser troubleshooting

Playback waits for four seconds of buffered data and every connected viewer before starting. Small audio/video segment gaps up to 200 ms count as playable data. If a stream buffers, the shared clock pauses until everyone is ready again. A slow transcode is never forced to start by a timeout.

Join authorizes the movie player during your tap, and the same video element is retained across stream changes. If a browser still blocks playback, use the normal play control; the shared clock waits. Refreshing or rejoining requires fresh buffer readiness. A stuck seek holds the clock and, when data is available, restarts the affected stream. This includes seeking into a larger media gap when later segments are buffered; recovery keeps the shared position.

Sync checks run locally in the existing player loop. If two ordinary corrections fail, Playparty restarts only the affected movie stream, with a 30-second cooldown. Pausing, buffering, seeking, and browser permission blocks do not trigger this recovery. If party updates stop arriving for eight seconds, that viewer's movie pauses while the party connection reconnects. Returning to the tab also requests current state. Movie and state reconnections retain the existing call. Delayed timing replies after an outage are ignored instead of shifting the playback clock.

Temporary movie network failures and playback server errors retry the affected stream with the same cooldown. Other errors offer **Retry movie**, which keeps the call connected. A stream change or failure also revokes readiness while manually paused, so Play waits for a working stream. Joining in another tab ends the older tab's local session instead of letting the tabs repeatedly displace each other.

Disconnected room membership expires after 45 seconds without contact; an open connection without client traffic expires after 90 seconds. Expiry releases the microphone, camera, and call audio and returns the viewer to Join. This also handles a client waking after suspension. Rejoining waits for fresh media and the current shared timeline.

Private playback logs are written to `data/playback.log`, with two rotated files and a total limit of roughly 6 MB. They record stream decisions, buffer levels, playback drift, readiness, shared pauses/resumes, transcode measurements, and automatic sync recovery. Call diagnostics record actual microphone mute and applied processing, plus audio output counts to detect duplicate playback. They omit names, media titles, tokens, and stream URLs.

```sh
tail -f data/playback.log
```

The app requests microphone echo cancellation and noise suppression. Safari may prompt again after rejoining or reloading when the site's permissions are set to Ask. Set Microphone and Camera to Allow in Safari's Website Settings to save that choice.

When testing two devices nearby, one device's microphone can pick up the other device's speaker and send it back. Muting that other microphone does not stop its speaker. Lower one speaker's volume or separate the devices to avoid the feedback loop.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
```

The browser check needs local Plex, LiveKit, and Chrome (`TEST_CHROME` overrides the browser path; `TEST_MOVIE` selects a library title). It uses an isolated party, fake camera/microphone devices, and a test-only host authenticator. It checks real movie/call playback, fullscreen, subtitles, episode labels, Stop, blocked autoplay, and synchronized recovery from a twelve-second transcode delay. `TEST_REMOTE=1` also checks adaptive quality under throttling. Run `node --disable-warning=ExperimentalWarning test/rejoin-browser.mjs` for refresh/rejoin and stuck-seek recovery, or `node --disable-warning=ExperimentalWarning test/call-browser.mjs` for multi-client calls and device controls. Content-dependent checks are skipped when suitable media is unavailable. `TEST_CAPTURE=1` writes ignored review captures; delete them after review.

Private configuration, authentication keys, binaries, dependencies, builds, and local captures are excluded from Git. No media files, library history, or real account details are included in this repository.

For repeated playback checks with four clients, run `node --disable-warning=ExperimentalWarning test/stress-browser.mjs`. It tests a slow remote connection, host and guest refreshes, repeated leave/rejoin, and abrupt tab closure. Each scenario requires ten continuous seconds of synchronized playback. Tests use separate parties and do not save Plex progress.

Additional two-client fault checks use the same local services and isolated parties:

| Command (run with `node --disable-warning=ExperimentalWarning`) | Checks |
| --- | --- |
| `test/network-fault-browser.mjs` | A 65-second movie HTTP outage, temporary/permanent playback API errors, and a disconnect long enough to expire membership. |
| `test/control-race-browser.mjs` | Lost pause updates, leaving during a delayed load, rapid seeks, and Stop/reselection with late responses. |
| `test/lifecycle-fault-browser.mjs` | Suspended tabs, foreground changes, and duplicate-tab takeover. |
| `test/rtc-link-fault-browser.mjs` | Linux: pauses and recreates only the isolated guest Chrome network process, verifies real call traffic interruption, then checks sync, mute, capture, and audio cleanup. |
| `test/webkit-recovery-browser.mjs` | Linux mobile WebKit: real video frames, subtitles, media gaps, Retry/Stop access, refresh/rejoin, HTTP/WebSocket outages, and landscape. |

Use `TEST_LONG_SLEEP=1` with the lifecycle script for genuine 65- and 100-second browser freezes, including mute retention and expired-session cleanup. Install the optional WebKit test browser with `npx playwright install webkit` before running its check.

Chrome tests use fake capture devices; WebKit tests deny physical camera/microphone access. These simulate browser suspension and link interruption. Linux WebKit uses Hls.js/MSE and cannot verify iOS native HLS, physical iPhone sleep, Safari permission persistence, acoustic echo, or an actual cellular/NAT handover.
