# Setup details

[Back to Playparty](../README.md)

## Plex credentials

Use the token of the account that owns your Plex Media Server. In Plex Web, sign in as that owner, open a library item, and choose **Get Info → View XML**. Copy the `X-Plex-Token` value from the XML page's address and paste it into setup's hidden token prompt. See [Plex's token instructions](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) for screenshots and details. Treat the token as a password.

On Linux, setup offers the standard Plex `Preferences.xml` location when it is readable. You can use another readable XML path or leave the path empty to enter the owner token. macOS setup uses the token prompt; Plex's macOS preferences are a property list rather than this Linux XML file.

Setup checks the token with Plex, verifies ownership of the selected server, and checks library access before writing configuration. Credentials stay on the server. The `.env` and `data/livekit.yaml` files are private and setup refuses to replace existing configuration.

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
| `PLEX_OWNER_EMAIL` | Account allowed to host, detected by setup. |
| `MOVIE_UPLOAD_MBPS` | Shared remote movie upload budget, default 70 Mbps. Set it below your upload speed to leave room for the call. Local viewers do not count against it. |
| `LIVEKIT_MANAGED` | Start the bundled call server with Playparty; set to `false` when running it separately. |

Plex sends compatible original video when it fits the viewer's allowance and converts for unsupported codecs, image subtitles, or bandwidth limits. Text subtitles use WebVTT. Browser support, Plex hardware acceleration, and your network determine quality. [Hardware transcoding requires Plex Pass](https://support.plex.tv/articles/115002178853-using-hardware-accelerated-streaming/); software conversion of 4K video with image subtitles can be demanding.

Playparty adjusts remote streams per viewer. Sustained slow downloads or buffering lower that viewer's Plex bitrate and resolution; a healthy connection recovers one quality step at a time. Browsers using native HLS can lower quality after repeated stalls but keep that setting until rejoining. Local network viewers keep compatible original quality. No Plex server-wide quality settings are changed. Stream replacement uses the shared buffering clock so viewers resume together.

## Existing authentication provider

The default is Plex owner sign-in. To require an existing login provider, set `AUTH_MODE=external`, `AUTH_URL`, `AUTH_COOKIE_NAMES` (comma-separated cookie names), and `AUTH_LOGIN_URL` in `.env`. `AUTH_LOGIN_LABEL` customizes the login link.

The server-side validation endpoint receives only the selected cookies and must return:

```json
{"authenticated": true, "email": "owner@example.com"}
```

Return HTTP 401 for expired or invalid sessions and use `Cache-Control: no-store`. The email must match `PLEX_OWNER_EMAIL`. The login provider and Playparty must share the relevant cookie's domain scope. Playparty checks the provider again before library access and shared controls. External mode disables Plex sign-in; provider failures never grant host access.

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

Playback waits for four seconds of buffered data and every connected viewer before starting. If a stream buffers, the shared clock pauses until everyone is ready again. A slow transcode is never forced to start by a timeout.

Join authorizes the movie player during your tap, and the same video element is retained across stream changes. If a browser still blocks playback, use the normal play control; the shared clock waits. Refreshing or rejoining requires fresh buffer readiness. A stuck seek holds the clock and, when data is available, restarts the affected stream.

Private playback logs are written to `data/playback.log`, with two rotated files and a total limit of roughly 6 MB. They record stream decisions, buffer levels, playback drift, readiness, shared pauses/resumes, and transcode measurements. Call diagnostics record actual microphone mute and applied processing, plus audio output counts to detect duplicate playback. They omit names, media titles, tokens, and stream URLs.

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

The browser check needs local Plex, LiveKit, and Chrome (`TEST_CHROME` overrides the browser path; `TEST_MOVIE` selects a library title). It uses an isolated party, fake camera/microphone devices, and a test-only owner authenticator. It checks real movie/call playback, fullscreen, subtitles, episode labels, Stop, blocked autoplay, and synchronized recovery from a twelve-second transcode delay. `TEST_REMOTE=1` also checks adaptive quality under throttling. Run `node --disable-warning=ExperimentalWarning test/rejoin-browser.mjs` for refresh/rejoin and stuck-seek recovery, or `node --disable-warning=ExperimentalWarning test/call-browser.mjs` for multi-client calls and device controls. Content-dependent checks are skipped when suitable media is unavailable. `TEST_CAPTURE=1` writes ignored review captures; delete them after review.

Private configuration, authentication keys, binaries, dependencies, builds, and local captures are excluded from Git. No media files, library history, or real account details are included in this repository.
