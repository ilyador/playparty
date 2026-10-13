import { randomUUID } from 'node:crypto';

export class Party {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.members = new Map();
    this.movie = null;
    this.position = 0;
    this.paused = true;
    this.updatedAt = clock();
    this.mediaVersion = 0;
    this.readinessVersion = 0;
    this.ready = new Set();
    this.wantsPlay = false;
  }

  join(name, owner, id = randomUUID()) {
    name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (!name) throw Object.assign(new Error('Enter your name to join.'), { status: 400 });
    const identity = owner ? 'owner' : id;
    const existing = this.members.get(identity);
    const member = { id: identity, name, owner: Boolean(owner), lastSeen: this.clock(), connected: false, ...existing };
    member.name = name;
    member.lastSeen = this.clock();
    this.members.set(identity, member);
    return member;
  }

  currentPosition() {
    return Math.min(this.position + (this.paused ? 0 : Math.max(0, this.clock() - this.updatedAt) / 1000), this.movie?.duration || Number.MAX_SAFE_INTEGER);
  }

  select(movie) {
    this.movie = movie;
    this.position = Math.min(Math.max(0, Number(movie.resumePosition) || 0), Math.max(0, (movie.duration || Number.MAX_SAFE_INTEGER) - 1));
    this.paused = true;
    this.updatedAt = this.clock();
    this.mediaVersion += 1;
    this.ready.clear();
    this.readinessVersion += 1;
    this.wantsPlay = true;
  }

  stop() {
    this.movie = null;
    this.position = 0;
    this.paused = true;
    this.updatedAt = this.clock();
    this.mediaVersion += 1;
    this.ready.clear();
    this.readinessVersion += 1;
    this.wantsPlay = false;
  }

  control(action, position) {
    if (!this.movie) return;
    if (action === 'pause') {
      // The ended element can finish just ahead of the shared clock.
      this.position = this.movie.duration > 0 && Number(position) >= this.movie.duration ? this.movie.duration : this.currentPosition();
      this.paused = true;
      this.wantsPlay = false;
      this.updatedAt = this.clock();
    } else if (action === 'play') {
      if (this.movie.duration > 0 && this.currentPosition() >= this.movie.duration) this.control('seek', 0);
      this.wantsPlay = true;
      this.startIfReady();
    } else if (action === 'seek') {
      const next = Number(position);
      if (!Number.isFinite(next)) return;
      const playing = !this.paused || this.wantsPlay;
      // Readiness needs future frames, so an end seek must stay playable.
      this.position = Math.min(Math.max(0, next), Math.max(0, (this.movie.duration || Number.MAX_SAFE_INTEGER) - 1));
      this.paused = true;
      this.updatedAt = this.clock();
      this.mediaVersion += 1;
      this.ready.clear();
      this.readinessVersion += 1;
      this.wantsPlay = playing;
    }
  }

  markReady(id, version) {
    if (version !== this.mediaVersion || !this.members.has(id)) return;
    this.ready.add(id);
    this.startIfReady();
  }

  buffering(id, version) {
    if (version !== this.mediaVersion || !this.members.has(id) || !this.movie) return false;
    if (this.paused && !this.wantsPlay) return this.ready.delete(id);
    if (!this.paused) {
      this.position = this.currentPosition();
      this.paused = true;
      this.updatedAt = this.clock();
      this.ready.clear();
      this.readinessVersion += 1;
    }
    this.ready.delete(id);
    this.wantsPlay = true;
    return true;
  }

  startIfReady() {
    const connected = [...this.members.values()].filter(m => m.connected);
    if (this.wantsPlay && connected.length && connected.every(m => this.ready.has(m.id))) {
      this.paused = false;
      this.wantsPlay = false;
      this.updatedAt = this.clock() + 650;
    }
  }

  snapshot() {
    return {
      serverTime: this.clock(),
      movie: this.movie,
      position: this.position,
      paused: this.paused,
      updatedAt: this.updatedAt,
      mediaVersion: this.mediaVersion,
      readinessVersion: this.readinessVersion,
      waiting: this.wantsPlay,
      hostPresent: [...this.members.values()].some(m => m.owner && m.connected),
      participants: [...this.members.values()].filter(m => m.connected).map(({ id, name, owner }) => ({ id, name, owner })),
    };
  }
}
