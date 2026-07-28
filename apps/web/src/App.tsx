import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppStore';
import { AppShell } from './components/layout/AppShell';
import { Backdrop } from './components/Backdrop';
import { ErrorPlate, LoadingRig } from './components/ui/primitives';
import { MainPage } from './pages/MainPage';
import { UserPage } from './pages/UserPage';
import { UsersPage } from './pages/UsersPage';
import { AdminPage } from './pages/AdminPage';

export default function App() {
  return (
    <AppProvider>
      <Backdrop />
      <Gate />
    </AppProvider>
  );
}

/**
 * Auth gate.
 *
 * There is no login screen in this bundle — the server owns it. In production
 * an unauthenticated request never receives this JavaScript at all; it's
 * redirected to /login before the static handler runs. This branch therefore
 * only fires when a session expires mid-visit (or in development, where Vite
 * serves the bundle unconditionally), and its job is simply to hand the browser
 * back to the server-rendered wall.
 */
function Gate() {
  const { status, error, offline, reload } = useApp();

  if (status === 'anonymous') {
    window.location.replace('/login');
    return <LoadingRig label="Redirecting to sign in" />;
  }

  if (status === 'booting') return <LoadingRig label="Warming up the grid" />;

  if (status === 'error') {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        {/*
          Installed as a PWA, the service worker will happily open the app shell
          from cache with no network behind it — so this branch is what an
          offline launch actually lands on. Saying so is more useful than a raw
          fetch error, and the store retries by itself the moment the link is
          back. Every board is a live aggregation, so there is nothing to show
          from cache here.
        */}
        <ErrorPlate
          message={
            offline
              ? "You're offline. Scrapyard reads every board live, so there's nothing to show until the link is back — this will retry itself."
              : error ?? 'Unknown error'
          }
          onRetry={() => void reload()}
        />
      </div>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/racers" element={<UsersPage />} />
        <Route path="/racer/:id" element={<UserPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
