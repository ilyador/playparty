import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CaretRight, FilmSlate, MagnifyingGlass, Play, SpinnerGap, X } from '@phosphor-icons/react';
import { api, contentTitle, post, resumeTime, type Content } from './types';

export default function Library({ onClose, onSelected }: { onClose: () => void; onSelected: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Content[]>([]);
  const [continueWatching, setContinueWatching] = useState<Content[]>([]);
  const [history, setHistory] = useState<Content[]>([]);
  const [filter, setFilter] = useState<'all' | 'movie' | 'show' | 'continue'>('all');
  const filterTouched = useRef(false);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const parent = history.at(-1);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ items: Content[]; continueWatching: Content[] }>(`library?q=${encodeURIComponent(query)}&parent=${parent?.id || ''}`, { signal: abort.signal });
        setItems(result.items);
        setContinueWatching(result.continueWatching || []);
        if (!filterTouched.current && !query && !parent) setFilter(result.continueWatching?.length ? 'continue' : 'all');
      } catch (error) { if (!abort.signal.aborted) setError((error as Error).message); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    }, query ? 220 : 0);
    return () => { abort.abort(); window.clearTimeout(timeout); };
  }, [query, parent?.id]);
  async function select(item: Content) {
    if (item.type === 'show' || item.type === 'season') {
      setHistory([...history, item]); setQuery(''); return;
    }
    setSelecting(item.id); setError('');
    try { await post('select', { id: item.id }); onSelected(); }
    catch (error) { setError((error as Error).message); setSelecting(null); }
  }
  const shown = parent ? items : filter === 'continue' && !query ? continueWatching : items.filter(item => ['all', 'continue'].includes(filter) || item.type === filter || (filter === 'show' && item.type === 'episode'));
  const rows = Boolean(parent) && shown.length > 0 && shown.every(item => item.type === 'episode');
  return <dialog ref={dialog} className="library" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <section className="library-content">
      <header className="library-heading">
        <div className="library-title">{parent && <button className="icon-button" onClick={() => setHistory(history.slice(0, -1))} aria-label="Back to library"><ArrowLeft size={21} /></button>}
          <h2>{parent?.title || 'What are we watching?'}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close movie picker"><X size={22} /></button>
      </header>
      {!parent && <div className="library-tools">
        <div className="library-filters" aria-label="Content type">{([...(continueWatching.length || filter === 'continue' ? ['continue'] as const : []), 'all', 'movie', 'show'] as const).map(value => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => { filterTouched.current = true; setFilter(value); }}>{value === 'continue' ? 'Continue' : value === 'all' ? 'All' : value === 'movie' ? 'Movies' : 'Shows'}</button>)}</div>
        <label className="search"><MagnifyingGlass size={19} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your library" aria-label="Search your Plex library" /></label>
      </div>}
      <div className="library-scroll">
        {loading && <div className="picker-message"><SpinnerGap className="spinner" size={24} /><span>Loading your library…</span></div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {!loading && !error && !shown.length && <div className="picker-message"><FilmSlate size={32} /><span>{query ? 'No matches. Try another title.' : 'Nothing here yet.'}</span></div>}
        {!loading && <div className={rows ? 'episode-list' : 'poster-grid'}>{shown.map(item => <button key={item.id} className={rows ? 'episode' : 'poster-item'} onClick={() => select(item)} disabled={selecting !== null}>
          {rows ? <><span className="episode-play">{selecting === item.id ? <SpinnerGap className="spinner" size={18} /> : <Play size={16} weight="fill" />}</span><span className="episode-copy"><strong>{item.title}</strong><span>{item.episodeTitle}{item.resumePosition ? ` · Resume ${resumeTime(item.resumePosition)}` : ''}</span></span><span className="episode-duration">{Math.round(item.duration / 60)} min</span></>
            : <><div className="poster-image">{item.hasPoster ? <img src={`/api/image/${item.id}`} alt="" loading="lazy" /> : <FilmSlate size={32} />}<span className="poster-play">{selecting === item.id ? <SpinnerGap className="spinner" size={22} /> : item.type === 'show' || item.type === 'season' ? <CaretRight size={22} /> : <Play size={20} weight="fill" />}</span>{item.resumePosition && item.duration ? <span className="poster-progress" style={{ width: `${Math.min(100, item.resumePosition / item.duration * 100)}%` }} /> : null}</div><strong>{contentTitle(item)}</strong><span className="poster-detail">{item.episodeNumber || item.year || (item.type === 'season' ? 'Season' : 'TV series')}{item.type === 'movie' && item.duration > 0 ? ` · ${Math.round(item.duration / 60)} min` : ''}</span>{Boolean(item.resumePosition) && <span className="resume-label">Resume {resumeTime(item.resumePosition!)}</span>}</>}
        </button>)}</div>}
      </div>
    </section>
  </dialog>;
}
