// Call directly in Join's trusted submit handler, before awaiting the request.
// Safari's permission to play media belongs to this element. Keep the element
// when a stream, subtitle, movie or React Player component changes.
export function createMovieElement(existing?: HTMLVideoElement): HTMLVideoElement {
  const element = existing || document.createElement('video');
  element.className = 'movie-video';
  element.playsInline = true;
  element.controls = false;
  element.autoplay = false;
  element.disablePictureInPicture = true;
  element.disableRemotePlayback = true;
  element.setAttribute('controlsList', 'nofullscreen noremoteplayback');
  element.preload = 'auto';
  if (!existing) element.muted = false;
  if (element.error) {
    element.removeAttribute('src');
    element.srcObject = null;
    element.load();
  }
  // play() consumes the trusted media gesture synchronously, even before a
  // source is available. Pause immediately: the shared party clock will start
  // actual playback later. Abort/unsupported-source rejections are expected.
  try { void element.play().catch(() => {}); } catch {}
  element.pause();
  return element;
}
