import { useEffect, useRef } from 'react';
import { Track, type Participant } from 'livekit-client';
import { MicrophoneSlash, VideoCameraSlash } from '@phosphor-icons/react';

export function Face({ participant, local = false, large = false }: { participant: Participant; local?: boolean; large?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const publication = participant.getTrackPublication(Track.Source.Camera);
  const track = publication?.videoTrack;
  const visible = Boolean(track && !publication?.isMuted);
  const name = participant.name || 'Guest';
  const initials = name.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    track.attach(element);
    element.muted = true;
    return () => { track.detach(element); };
  }, [track]);
  return <div className={`face${large ? ' face-large' : ''}`}>
    <video ref={video} autoPlay muted playsInline controls={false} disablePictureInPicture disableRemotePlayback className={`${visible ? 'visible' : ''}${local ? ' self-video' : ''}`} />
    {!visible && <div className="face-placeholder"><span className="initials">{initials}</span></div>}
    <div className="face-caption"><span>{name}{local && <span className="you-label"> · You</span>}</span>
      <span className="face-indicators">{!participant.isCameraEnabled && <VideoCameraSlash size={14} />}{!participant.isMicrophoneEnabled && <MicrophoneSlash size={14} />}</span>
    </div>
  </div>;
}
