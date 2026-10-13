# Playparty

A movie and a video call for the Plex owner and up to four friends. Guests open one URL, enter their name, and join. The owner picks what plays; playback stays synchronized and everyone chooses their own subtitles.

Remote streams adjust to the connection. Local playback keeps the highest compatible quality, and your other Plex apps keep their existing settings.

![Playparty playing a cat movie with cats in the video call](docs/screenshots/playparty.png)

## Install

You need **macOS or Linux (x64 or arm64)**, **Node.js 22.14+**, npm, Git, and a running **Plex Media Server** with your libraries. New to Plex? Start with [Plex's quick-start guide](https://support.plex.tv/articles/200264746-quick-start-step-by-step-guides/). On macOS, install [Homebrew](https://brew.sh) first.

```sh
git clone https://github.com/ilyador/playparty.git
cd playparty
npm ci
npm run setup
npm start
```

Setup asks for your Playparty address, Plex server address, and the server owner's [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/). Linux can also use a readable Plex `Preferences.xml`. Setup verifies ownership, installs LiveKit for the call, and saves private configuration.

For a local trial, accept `http://localhost:5175` and open it in your browser. Turn on **I am the host** and join, then sign in to Plex as the server owner. Friends enter only their name.

Keep `npm start` running while watching. Ctrl+C stops the app and call server. Setup preserves existing configuration; edit `.env` to change it.

## Share with friends

Camera and microphone access outside localhost requires **HTTPS**. Give setup your HTTPS address, point its DNS record at your server, and use an HTTPS reverse proxy. With [Caddy](https://caddyserver.com/docs/install):

```caddyfile
playparty.example.com {
    reverse_proxy 127.0.0.1:5175
}
```

Forward these router ports to the server and allow them in its firewall:

- **443/TCP** for HTTPS and call signaling.
- **7882/UDP** for camera and microphone media.
- **7881/TCP** for call fallback when UDP is unavailable.

Caddy may also need **80/TCP** for certificates and redirects. Restart Playparty after setting up the forwards, then send friends your HTTPS URL. Anyone with the URL can join an available guest seat; only the owner can choose and control the movie.

[Setup details, settings, updates, and troubleshooting](docs/setup.md)
