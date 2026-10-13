# Playparty

A movie and a video call, for the Plex owner and up to four friends. Guests open one URL, enter their name, and join the current party. No chat or guest accounts.

Plex supplies the library, artwork, and media. Playparty supplies the browser interface, shared playback clock, and a self-hosted LiveKit call.

- Browse movies and series in a compact poster picker.
- The Plex owner selects content and controls play, pause, seek, and Stop.
- Stop returns the host to the picker and keeps everyone in the call.
- Each viewer chooses their own subtitles or turns them off. Plex provides WebVTT for text tracks and converts video for image tracks.
- Fullscreen fills the screen with the movie and overlays the call videos at the bottom center. Controls hide while watching; keyboard focus keeps them accessible. Browsers that deny native fullscreen use a viewport-filling layout.
- Episode titles include the series name, season, and episode number, including in the lobby.
- Continue watching uses Plex's saved progress and resumes at the saved position.

## Requirements

Linux, Node.js 22.14 or newer, npm, an existing Plex Media Server, and an existing homelab login that identifies the Plex owner. LiveKit runs as a separate native process; no Redis or cloud account is needed for this single-server setup.

Public camera and microphone access needs HTTPS. Guests connect directly over the internet; they do not need a VPN. Restrictive networks may need a TURN server, which this minimal deployment does not include.

## Install

The example user services expect the checkout at `~/Dev/playparty`. Adjust their paths if you choose another location.

```sh
mkdir -p ~/Dev
cd ~/Dev
git clone https://github.com/ilyador/playparty.git
cd playparty
npm ci
cp .env.example .env
chmod 600 .env
mkdir -p bin data
```

Edit `.env` with your HTTPS address and Plex configuration. Either point `PLEX_PREFERENCES` at the existing Plex `Preferences.xml`, readable by the service user, or set `PLEX_TOKEN` and `PLEX_OWNER_EMAIL` explicitly. The owner email must match the account returned by your homelab login.

Download the appropriate Linux binary from [LiveKit releases](https://github.com/livekit/livekit/releases), verify its release checksum, and place the executable at `bin/livekit-server`. This project has been tested with LiveKit 1.13.9.

```sh
chmod +x bin/livekit-server
cp deploy/livekit.example.yaml data/livekit.yaml
chmod 600 data/livekit.yaml
openssl rand -hex 32
```

Put the generated secret in both `.env` (`LIVEKIT_API_SECRET`) and `data/livekit.yaml` (the value under `keys.playparty`). Keep `LIVEKIT_API_KEY=playparty`, or change the key name in both files. Replace the example hostnames in `.env`.

### Existing host login

The name form includes **I am the host**. It defaults on when Playparty recognizes the Plex owner's existing homelab session. The server checks that session again before allowing library access or shared playback controls. Guests need only their name.

`HOMELAB_AUTH_URL` is a server-side endpoint that validates the `homelab_session` cookie and returns:

```json
{"authenticated": true, "email": "owner@example.com"}
```

For an invalid or expired session it must return HTTP 401. Validate the session with the homelab's existing session logic and use `Cache-Control: no-store`. Playparty compares the returned email with the Plex owner's email; it never reads the login database or copies session records.

For an Express homelab that already has `sessionFor(req)`, the endpoint can be:

```js
app.get('/api/auth/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, email: session.email });
});
```

Configure the existing login cookie with a parent-domain scope shared by the homelab and Playparty, such as `home.example.com` and `playparty.example.com`. Sign into the homelab in the same browser before joining as host. `HOMELAB_LOGIN_URL` controls the login link. Do not expose the validation endpoint's upstream port to the internet.

### Start the services

```sh
npm run build
mkdir -p ~/.config/systemd/user
ln -s "$PWD/deploy/playparty.service" ~/.config/systemd/user/playparty.service
ln -s "$PWD/deploy/playparty-call.service" ~/.config/systemd/user/playparty-call.service
systemctl --user daemon-reload
systemctl --user enable --now playparty-call.service playparty.service
```

To keep user services running after logout, enable lingering for the service user with `sudo loginctl enable-linger "$USER"`.

```sh
systemctl --user status playparty.service playparty-call.service
journalctl --user -u playparty.service -u playparty-call.service
```

For foreground development, start LiveKit separately, run `npm run build`, then `npm start`. The application listens on `127.0.0.1:5175` by default.

### HTTPS and ports

Create a DNS record pointing your Playparty hostname to your public address. Dynamic DNS, including dedyn.io, works. Add `deploy/Caddyfile.fragment` to your existing Caddy configuration after replacing `playparty.example.com`, then validate and reload Caddy.

Caddy proxies the app to port 5175 and `/livekit/*` signaling to port 7880. Keep these two upstream ports on loopback. Forward the following router ports to the server's reserved LAN address and allow them in its firewall:

| Port | Purpose |
| --- | --- |
| 443/TCP | HTTPS and WebSocket signaling through Caddy |
| 7882/UDP | LiveKit camera and microphone media |
| 7881/TCP | LiveKit media fallback |

Allow 80/TCP if your existing Caddy certificate setup uses HTTP validation or you want HTTP redirects.

```sh
sudo ufw allow 7882/udp comment 'Playparty video and audio'
sudo ufw allow 7881/tcp comment 'Playparty call TCP fallback'
```

Restart `playparty-call.service` after setting up the forwards so LiveKit discovers the public address. `deploy/publish.sh` is an optional helper for an existing Docker container named `caddy`; it applies these firewall rules, validates Caddy, and restarts that container.

### Quality and bandwidth

Plex copies compatible video when it fits the viewer's bandwidth allowance and converts when required by codec compatibility, image subtitles, or the allowance. The UI reports **Original video** or **Optimized video**. Text subtitles use a separate rendition.

`MOVIE_UPLOAD_MBPS` limits the shared remote movie upload budget. It defaults to 70 Mbps; set it below your measured upload speed to leave capacity for the call. Each remote viewer receives an allowance based on the current party size. The local host's movie does not use that remote upload budget. Browser compatibility, Plex hardware acceleration, and the network determine achievable quality; this is not an adaptive bandwidth estimator.

Anyone with the URL can join an available guest seat. Share it with the people you want in the party. Library browsing and shared playback controls remain restricted to the authenticated Plex owner. Only the current movie's artwork and streaming resources are available to guests.

## Updates

```sh
git pull --ff-only
npm ci
npm run build
systemctl --user restart playparty.service
```

The party state is in memory and resets when the app restarts. Updating the frontend or Node app does not require changing the LiveKit binary. Update LiveKit separately after reviewing its release notes.

Playback progress is stored in Plex through its [timeline API](https://developer.plex.tv/pms/), every ten seconds while the host is connected and on pause, seek, Stop, host departure, or server shutdown. The picker opens on **Continue** when Plex has items to continue. Selecting an in-progress title resumes automatically; seek to the beginning to restart it. Guests' subtitle changes do not overwrite the shared progress. The lobby refreshes its current selection while someone is deciding whether to join.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
```

The browser check requires local Plex and LiveKit plus Chrome (`TEST_CHROME` overrides `/usr/bin/google-chrome`). It uses an isolated server on port 5176, isolated browser contexts, fake camera/microphone devices, and a test-only owner authenticator. It does not change production sessions. It checks real playback, received call media, fullscreen positioning, subtitle choices, episode titles, and Stop. Subtitle and series checks use available library content; missing content is reported as skipped. `TEST_MOVIE` selects a particular movie. `TEST_CAPTURE=1` writes ignored review screenshots under `.impeccable/review/`; delete them after review.

`test/public-call.mjs` additionally checks public IPv4 camera/audio between this server and another machine over SSH, excluding private/VPN ICE candidates. Run it only when the production party is empty. Set `TEST_SSH_HOST` to the remote SSH host; that host needs Node, Playwright, and its installed Chromium. Optional variables are `TEST_REMOTE_NODE`, `TEST_REMOTE_PLAYWRIGHT`, and `TEST_REMOTE_BROWSER_CACHE`. It reads `PUBLIC_URL` from the environment or `.env`.

## Private files

`.env`, `data/`, `bin/`, build output, dependencies, browser captures, and local design-tool settings are excluded from Git. Plex tokens and internal file paths stay on the server. Example configuration uses placeholder hostnames and credentials; no movie files, real library listings, or login data are included.
