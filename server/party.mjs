import { randomUUID } from 'node:crypto';

export class Party {
  constructor({ clock = Date.now, capacity = 5 } = {}) {
    this.clock = clock;
    this.capacity = capacity;
    this.members = new Map();
    this.movie = null;
    this.position = 0;
    this.paused = true;
    this.updatedAt = clock();
    this.mediaVersion = 0;
    this.ready = new Set();
    this.wantsPlay = false;
  }

  join(name, owner, id = randomUUID()) {
    name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    if (!name) throw Object.assign(new Error('Enter your name to join.'), { status: 400 });
    const identity = owner ? 'owner' : id;
    const existing = this.members.get(identity);
    if (!existing) {
      const guests = [...this.members.values()].filter(m => !m.owner).length;
      if ((!owner && guests >= this.capacity - 1) || this.members.size >= this.capacity) {
        throw Object.assign(new Error('The party is full. Try again when someone leaves.'), { status: 409 });
      }
    }
    const member = { id: identity, name, owner: Boolean(owner), lastSeen: this.clock(), connected: false, ...existing };
    member.name = name;
    member.lastSeen = this.clock();
    this.members.set(identity, member);
    return member;
  }

  currentPosition() {
    return this.position + (this.paused ? 0 : Math.max(0, this.clock() - this.updatedAt) / 1000);
  }

  select(movie) {
    this.movie = movie;
    this.position = Math.min(Math.max(0, Number(movie.resumePosition) || 0), Math.max(0, (movie.duration || Number.MAX_SAFE_INTEGER) - 1));
    this.paused = true;
    this.updatedAt = this.clock();
    this.mediaVersion += 1;
    this.ready.clear();
    this.wantsPlay = true;
  }

  stop() {
    this.movie = null;
    this.position = 0;
    this.paused = true;
    this.updatedAt = this.clock();
    this.mediaVersion += 1;
    this.ready.clear();
    this.wantsPlay = false;
  }

  control(action, position) {
    if (!this.movie) return;
    if (action === 'pause') {
      this.position = this.currentPosition();
      this.paused = true;
      this.wantsPlay = false;
      this.updatedAt = this.clock();
    } else if (action === 'play') {
      this.wantsPlay = true;
      this.startIfReady();
    } else if (action === 'seek') {
      const next = Number(position);
      if (!Number.isFinite(next)) return;
      const playing = !this.paused || this.wantsPlay;
      this.position = Math.min(Math.max(0, next), this.movie.duration || Number.MAX_SAFE_INTEGER);
      this.paused = true;
      this.updatedAt = this.clock();
      this.mediaVersion += 1;
      this.ready.clear();
      this.wantsPlay = playing;
    }
  }

  markReady(id, version) {
    if (version !== this.mediaVersion || !this.members.has(id)) return;
    this.ready.add(id);
    this.startIfReady();
  }

  startIfReady(force = false) {
    const connected = [...this.members.values()].filter(m => m.connected);
    if (this.wantsPlay && connected.length && (force || connected.every(m => this.ready.has(m.id)))) {
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
      waiting: this.wantsPlay,
      hostPresent: [...this.members.values()].some(m => m.owner && m.connected),
      participants: [...this.members.values()].filter(m => m.connected).map(({ id, name, owner }) => ({ id, name, owner })),
    };
  }
}
