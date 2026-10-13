# Playparty

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React and Vite build the static interface; one Node service owns the party and integrates Plex; one self-hosted LiveKit process carries the call. Native CSS and self-hosted Geist; no prebuilt conferencing interface.

## Users

People with an accessible Plex server and their friends. Personal use, not a commercial service. There is no fixed participant limit.

## Product Purpose

Open one URL, enter a name, and join the current call and movie. Choose to host when the machine running Playparty can access its configured Plex server; otherwise the host option is hidden. Guests are never automatically promoted to host.

An active hosted party prevents another visitor from taking over. Empty parties clear automatically when the last member leaves or expires; a brief network disconnect preserves the existing reconnect window.

## Operating Context

Self-hosted at a configured HTTPS address. Plex is a backend, not the client. Existing Plex metadata supplies a simplified content picker. Standalone installs check configured Plex library access automatically, with no browser Plex sign-in or email matching. An optional external session provider restricts host and library access to authenticated sessions. Guests enter only their name.

## Capabilities and Constraints

One party, displayed names, camera and microphone, synchronized movie playback, host content selection and playback controls. Original media when compatible, Plex conversion when necessary. Guests enter only their name. No chat, rooms to choose, accounts to create, billing, reactions, playlists or other social features. Keep movie traffic from starving the call. Verify a second participant over an independent network connection.

## Brand Commitments

Playparty. Clean dark, sleek, modern, minimal. WatchParty's dense interface is an anti-reference. Faces and the movie lead; controls recede.

## Evidence on Hand

The running Plex server supplies real posters, titles and playback streams. Do not fabricate library content or show demo participants as real people.
