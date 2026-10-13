export type Content = {
  id: string;
  title: string;
  type: 'movie' | 'show' | 'season' | 'episode';
  year?: number;
  duration: number;
  summary: string;
  resolution?: string;
  hasPoster: boolean;
  episodeTitle?: string;
  seriesTitle?: string;
  episodeNumber?: string;
  episodeDetails?: string;
  resumePosition?: number;
  lastPlayedAt?: number;
  subtitles?: { id: string; label: string; burn: boolean }[];
};
export type Member = { id: string; name: string; owner: boolean };
export type PartyState = {
  serverTime: number;
  movie: Content | null;
  position: number;
  paused: boolean;
  updatedAt: number;
  mediaVersion: number;
  waiting: boolean;
  hostPresent: boolean;
  participants: Member[];
};
export type Joined = {
  identity: string;
  name: string;
  owner: boolean;
  token: string;
  livekitUrl: string;
  state: PartyState;
};

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  let data;
  try { data = await response.json(); } catch {}
  if (!response.ok || data == null) throw new Error(data?.error || 'The server is reconnecting. Try again in a moment.');
  return data;
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const positionAt = (state: PartyState, now: number) => state.position + (state.paused ? 0 : Math.max(0, now - state.updatedAt) / 1000);
export const contentTitle = (content: Content) => content.seriesTitle ? `${content.seriesTitle} · ${content.title}` : content.title;
export const resumeTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
