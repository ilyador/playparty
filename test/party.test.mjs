import test from 'node:test';
import assert from 'node:assert/strict';
import { Party } from '../server/party.mjs';

test('four guests cannot occupy the owner’s seat or become the host', () => {
  const party = new Party();
  for (let i = 0; i < 4; i++) party.join(i === 0 ? 'owner' : `Guest ${i}`, false, `guest-${i}`);
  assert.throws(() => party.join('Fifth guest', false), { status: 409 });
  const host = party.join('Plex owner', true);
  assert.equal(host.id, 'owner');
  assert.equal(party.members.get('guest-0').owner, false);
  assert.equal(party.members.size, 5);
});

test('playback starts on a shared future clock only after current-version readiness', () => {
  let now = 1000;
  const party = new Party({ clock: () => now });
  const host = party.join('Host', true);
  const guest = party.join('Guest', false);
  host.connected = guest.connected = true;
  party.select({ id: '1', duration: 120 });
  party.markReady(host.id, party.mediaVersion);
  party.markReady(guest.id, party.mediaVersion - 1);
  assert.equal(party.paused, true);
  party.markReady(guest.id, party.mediaVersion);
  assert.equal(party.updatedAt, 1650);
  assert.equal(party.currentPosition(), 0);
  now = 3650;
  assert.equal(party.currentPosition(), 2);
  party.control('pause');
  now += 5000;
  assert.equal(party.currentPosition(), 2);
  party.control('seek', 900);
  assert.equal(party.currentPosition(), 120);
  assert.equal(party.paused, true);
});

test('stop clears playback and old readiness while preserving the call members', () => {
  const party = new Party();
  const host = party.join('Host', true);
  host.connected = true;
  party.select({ id: '1', duration: 120 });
  const version = party.mediaVersion;
  party.markReady(host.id, version);
  party.stop();
  party.markReady(host.id, version);
  party.startIfReady(true);
  assert.equal(party.movie, null);
  assert.equal(party.position, 0);
  assert.equal(party.paused, true);
  assert.equal(party.wantsPlay, false);
  assert.equal(party.ready.size, 0);
  assert.equal(party.mediaVersion, version + 1);
  assert.equal(party.snapshot().participants.length, 1);
});

test('selection resumes from Plex progress and clamps invalid or completed offsets', () => {
  const party = new Party();
  party.select({ id: '1', duration: 120, resumePosition: 73.5 });
  assert.equal(party.position, 73.5);
  party.select({ id: '1', duration: 120, resumePosition: 900 });
  assert.equal(party.position, 119);
  party.select({ id: '1', duration: 120, resumePosition: -3 });
  assert.equal(party.position, 0);
});

test('a slow transcode freezes the shared clock until every connected viewer buffers, without forced startup', () => {
  let now = 1000;
  const party = new Party({ clock: () => now });
  const host = party.join('Host', true), guest = party.join('Guest', false);
  host.connected = guest.connected = true;
  party.select({ id: '1', duration: 120 });
  party.markReady(host.id, party.mediaVersion);
  now += 40000; party.startIfReady(true);
  assert.equal(party.paused, true);
  party.markReady(guest.id, party.mediaVersion);
  now += 5000;
  const position = party.currentPosition();
  assert.equal(party.buffering(guest.id, party.mediaVersion), true);
  now += 30000; assert.equal(party.currentPosition(), position);
  party.markReady(host.id, party.mediaVersion); assert.equal(party.paused, true);
  party.markReady(guest.id, party.mediaVersion - 1); assert.equal(party.paused, true);
  party.markReady(guest.id, party.mediaVersion); assert.equal(party.paused, false);
  assert.equal(party.position, position);
  party.control('pause');
  assert.equal(party.buffering(guest.id, party.mediaVersion), false);
  assert.equal(party.wantsPlay, false);
});
