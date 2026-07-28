import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

/*
 * Register the service worker so the app is installable as a PWA. Production
 * only — in dev the worker would fight Vite's HMR and cache stale modules. The
 * SW is served from the site root so its scope covers every route.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed registration must never block the app — installability is a
      // progressive enhancement, not a requirement.
    });
  });
}
