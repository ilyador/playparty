# Playparty

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React and Vite build the static interface; one Node service owns the party and integrates Plex; one self-hosted LiveKit process carries the call. Native CSS and self-hosted Geist; no prebuilt conferencing interface.

## Users

The Plex server owner and up to four friends. Personal use, not a commercial service.

## Product Purpose

Open one URL, enter a name, and join the current call and movie. The Plex owner is always the host; guests are never promoted to host.

## Operating Context

Hosted as part of an existing homelab at its configured HTTPS address. Plex is a backend, not the client. Existing Plex metadata supplies a simplified content picker. The existing homelab owner session identifies the host without adding a guest login.

## Capabilities and Constraints

One party, at most five participants, displayed names, camera and microphone, synchronized movie playback, host content selection and playback controls. Original media when compatible, Plex conversion when necessary. Guests enter only their name. No chat, rooms to choose, accounts to create, billing, reactions, playlists or other social features. Keep movie traffic from starving the call. Verify a second participant over an independent network connection.

## Brand Commitments

Playparty. Clean dark, sleek, modern, minimal. WatchParty's dense interface is an anti-reference. Faces and the movie lead; controls recede.

## Evidence on Hand

The running Plex server supplies real posters, titles and playback streams. Do not fabricate library content or show demo participants as real people.
