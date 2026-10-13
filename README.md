# Playparty

A movie and a video call, for the Plex owner and up to four friends. Guests open one URL, enter their name, and join. No chat or guest accounts.

![Playparty playing a cat movie with cats in the video call](docs/screenshots/playparty.png)

*Actual interface, with fictional names and cat placeholders for the movie and cameras.*

Plex supplies your library, artwork, subtitles, and streaming. Playparty adds synchronized playback and a self-hosted LiveKit call. The owner chooses what plays; each viewer chooses their own subtitles. Fullscreen keeps the call videos at the bottom center on desktop; landscape phones use smaller tiles at the bottom left, and Stop returns the host to the picker without ending the call. Continue watching resumes from the position saved in Plex.

## Install

You need **Linux x64 or arm64**, **Node.js 22.14+**, npm, Git, and a running **Plex Media Server** with your media libraries. If you need to set up Plex first, follow [Plex's quick-start instructions](https://support.plex.tv/articles/200264746-quick-start-step-by-step-guides/).

```sh
git clone https://github.com/ilyador/playparty.git
cd playparty
npm ci
npm run setup
npm start
```

Setup asks for your Playparty address, Plex server address, and either a readable Plex `Preferences.xml` or the server owner's [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/). It verifies ownership, downloads LiveKit 1.13.9, checks its release checksum, and generates the private configuration. No cloud call account, Redis, or separate login service is required.

For a local trial, accept `http://localhost:5175` and open it in your browser. Turn on **I am the host** and join; Playparty takes you to Plex to sign in as the server owner. Guests enter only their name. Plex credentials stay on the server.

`npm start` runs the app and LiveKit together. Keep it running while watching; Ctrl+C stops both. Setup refuses to overwrite existing configuration. Change settings later in `.env`.

## Share with friends

Camera and microphone access outside localhost requires **HTTPS**. Give setup your HTTPS address, point its DNS record at your server, and put Playparty behind an HTTPS reverse proxy. For [Caddy](https://caddyserver.com/docs/install), this is enough:

```caddyfile
playparty.example.com {
    reverse_proxy 127.0.0.1:5175
}
```

Playparty also proxies LiveKit signaling, so only one HTTPS upstream is needed. App port 5175 and LiveKit signaling port 7880 stay on loopback. Forward these ports through your router to the server and allow them in its firewall:

| Port | Purpose |
| --- | --- |
| 443/TCP | HTTPS and WebSocket signaling |
| 7882/UDP | Call camera and microphone media |
| 7881/TCP | Call fallback when UDP is unavailable |

Caddy may also need 80/TCP for certificate validation and HTTP redirects. Restart Playparty after configuring the forwards. Restrictive networks can require a [TURN server](https://docs.livekit.io/transport/self-hosting/), which the minimal setup does not include.

Anyone with the URL can join an available guest seat. Library selection and playback controls require owner authentication.

Movie audio fades to 30% while someone speaks and returns after a short silence. Browsers with read-only video volume, including restricted iOS playback, use temporary movie-only mute instead. Personal mute choices are preserved. Microphone capture requests echo cancellation and noise suppression, and joining requests camera and microphone together. Safari can still prompt again on rejoining or reloading when its per-site permissions are set to Ask. Set Microphone and Camera to Allow in Safari's Website Settings for this site to save that choice; approving a capture prompt does not necessarily change the saved rule.

## Settings

- `PUBLIC_URL`: the address people open. Restart after changing it.
- `PLEX_URL`: the Plex server address reachable from Playparty.
- `PLEX_PREFERENCES` or `PLEX_TOKEN`: server-side Plex credentials.
- `PLEX_OWNER_EMAIL`: account allowed to host; setup detects it automatically.
- `MOVIE_UPLOAD_MBPS`: shared remote movie upload budget, default 70 Mbps. Set it below your upload speed to leave room for the call. Local host playback does not count against it.

Plex sends compatible original video when it fits the viewer's allowance and converts for unsupported codecs, image subtitles, or bandwidth limits. Text subtitles use WebVTT. Browser support, Plex hardware acceleration, and your network determine quality. [Hardware transcoding requires Plex Pass](https://support.plex.tv/articles/115002178853-using-hardware-accelerated-streaming/); software conversion of 4K video with image subtitles can be demanding.

### Optional existing authentication

The default is Plex owner sign-in. To require an existing login provider instead, set `AUTH_MODE=external`, `AUTH_URL`, `AUTH_COOKIE_NAMES` (comma-separated cookie names), and `AUTH_LOGIN_URL` in `.env`. `AUTH_LOGIN_LABEL` customizes the login link.

The server-side validation endpoint receives only the selected cookies and must return:

```json
{"authenticated": true, "email": "owner@example.com"}
```

Return HTTP 401 for expired or invalid sessions and use `Cache-Control: no-store`. The email must match `PLEX_OWNER_EMAIL`. The login provider and Playparty must share the relevant cookie's domain scope. Playparty checks the provider again before library access and shared controls. **External mode disables Plex sign-in entirely; provider failures never grant host access.**

### Run as a service

For an always-on Linux server, the example user services in `deploy/` run the app and LiveKit separately. They expect the checkout at `~/Dev/playparty`; edit their paths if necessary. Set `LIVEKIT_MANAGED=false` before enabling them to avoid starting LiveKit twice.

```sh
mkdir -p ~/.config/systemd/user
ln -s "$PWD/deploy/playparty.service" ~/.config/systemd/user/playparty.service
ln -s "$PWD/deploy/playparty-call.service" ~/.config/systemd/user/playparty-call.service
systemctl --user daemon-reload
systemctl --user enable --now playparty-call.service playparty.service
```

Use `sudo loginctl enable-linger "$USER"` to keep user services running after logout. Logs: `journalctl --user -u playparty.service -u playparty-call.service`.

## Update

Stop the app, then:

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

If using the example services, use `systemctl --user restart playparty.service` instead of `npm start`. Party state resets on restart; playback progress stays in Plex. Update the LiveKit binary separately when needed.

## Playback diagnostics

Private playback logs are written to `data/playback.log`, with two rotated files and a total limit of roughly 6 MB. They record stream decisions, buffer levels, playback drift, readiness, shared pauses/resumes, and transcode measurements when buffering occurs. They omit names, media titles, tokens, and stream URLs. No separate monitoring service is needed.

```sh
tail -f data/playback.log
```

Playback waits for four seconds of buffered data and every connected viewer before starting. If a stream buffers, the shared clock pauses until everyone is ready again. A slow transcode is never forced to start by a timeout.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
```

The browser check needs local Plex, LiveKit, and Chrome (`TEST_CHROME` overrides the browser path; `TEST_MOVIE` selects a library title). It uses an isolated party, fake camera/microphone devices, and a test-only owner authenticator; production sessions and Plex progress are unaffected. It checks real movie/call playback, fullscreen, subtitles, episode labels, Stop, and synchronized recovery from a twelve-second transcode delay. Content-dependent checks are skipped when suitable media is unavailable. `TEST_CAPTURE=1` writes ignored review captures; delete them after review.

Private configuration, authentication keys, binaries, dependencies, builds, and local captures are excluded from Git. No media files, library history, or real account details are included in this repository.
