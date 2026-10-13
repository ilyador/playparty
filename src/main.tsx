import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './style.css';
import App from './App';

const viewport = window.visualViewport;
const fitViewport = () => {
  const height = viewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--viewport-height', `${height}px`);
  document.documentElement.classList.toggle('compact-viewport', height < 700);
};
fitViewport();
(viewport ?? window).addEventListener('resize', fitViewport);

// Safari can ignore viewport scale limits; cancel its native pinch gesture too.
const preventZoom = (event: Event) => event.preventDefault();
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, preventZoom, { passive: false });
const preventPinch = (event: TouchEvent) => { if (event.touches.length > 1) event.preventDefault(); };
document.addEventListener('touchstart', preventPinch, { passive: false });
document.addEventListener('touchmove', preventPinch, { passive: false });
document.addEventListener('wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
