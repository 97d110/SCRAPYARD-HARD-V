import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutGrid,
  LogOut,
  Menu,
  Shield,
  Trophy,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useApp } from '../../state/AppStore';
import { PunTicker } from '../PunTicker';
import { ArthurLottie } from '../arthur/ArthurLottie';
import { ArthurFlyby } from '../arthur/ArthurFlyby';
import { Avatar } from '../ui/primitives';

/**
 * Deterministic scatter for the wordmark ship's ambient sparks — generated
 * once, not per render. Each one idles for most of its own cycle and only
 * briefly flares outward (see `.hero-spark` in index.css); uneven per-spark
 * duration/delay is what keeps the bursts from firing in lockstep.
 */
const SHIP_SPARKS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2 + i * 0.5;
  const dist = 20 + (i % 3) * 8;
  return {
    id: i,
    dx: Math.round(Math.cos(angle) * dist),
    dy: Math.round(Math.sin(angle) * dist),
    delay: Number(((i * 0.35) % 2).toFixed(2)),
    duration: 2 + (i % 4) * 0.5,
    size: i % 3 === 0 ? 3 : 2,
    white: i % 3 === 0,
  };
});

/**
 * The chrome every page sits inside: pun ticker at the very top, then the
 * top bar, then a side menu (permanent rail on desktop, slide-over on mobile).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, puns, logout, celebration, clearCelebration } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Close the slide-over whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Lock body scroll behind the slide-over.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const nav = [
    { to: '/', label: 'Leaderboard', icon: Trophy, end: true },
    { to: '/racers', label: 'Racers', icon: Users, end: false },
    ...(me ? [{ to: `/racer/${me.id}`, label: 'My Profile', icon: UserRound, end: false }] : []),
    ...(me?.role === 'admin'
      ? [{ to: '/admin', label: 'Admin', icon: Shield, end: false }]
      : []),
  ];

  return (
    <div className="relative min-h-screen">
      {/* Arthur's victory lap, launched from anywhere in the app. */}
      <ArthurFlyby
        runId={celebration?.id ?? null}
        accent={celebration?.accent}
        caption={celebration?.caption}
        onDone={clearCelebration}
      />

      {/* Top prompter. The Cytactic mark lives inside it now, as a normal
          child sharing the bar rather than floating above it. */}
      <div className="fixed inset-x-0 top-0 z-50">
        <PunTicker puns={puns} />
      </div>

      {/* Top bar. */}
      <header
        className="fixed inset-x-0 z-40 border-b border-hairline bg-[#06080f]/85 backdrop-blur-xl"
        style={{ top: 'var(--ticker-h)', height: 'var(--topbar-h)' }}
      >
        <div className="shell flex h-full items-center gap-3">
          <button
            className="btn btn-ghost !px-2.5 !py-2 lg:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>

          <Link to="/" className="group flex min-w-0 items-center gap-3">
            {/* The ship — bigger than before, with a soft breathing halo and
                sparks that shoot outward and fade every so often rather than
                continuously. */}
            <span
              className="relative shrink-0 transition-transform group-hover:scale-110"
              aria-hidden="true"
            >
              <span
                className="hero-ship-halo pointer-events-none absolute rounded-full"
                style={{
                  inset: '-8%',
                  background: 'radial-gradient(circle, rgba(255,106,0,0.55), transparent 60%)',
                  filter: 'blur(4px)',
                }}
              />
              {SHIP_SPARKS.map((spark) => (
                <span
                  key={spark.id}
                  className="hero-spark pointer-events-none absolute left-1/2 top-1/2 rounded-full"
                  style={{
                    width: spark.size,
                    height: spark.size,
                    background: spark.white ? '#fff' : '#FF6A00',
                    boxShadow: '0 0 6px #FF6A00',
                    ['--dx' as string]: `${spark.dx}px`,
                    ['--dy' as string]: `${spark.dy}px`,
                    ['--dur' as string]: `${spark.duration}s`,
                    animationDelay: `${spark.delay}s`,
                  }}
                />
              ))}
              <ArthurLottie size={56} accent="#FF6A00" className="relative" />
            </span>
            <span className="min-w-0">
              <span className="headline block truncate text-lg leading-none sm:text-2xl 3xl:text-3xl">
                Scrapyard Hard V
              </span>
              <span className="label hidden items-center gap-1 text-[0.5rem] sm:flex">
                <img
                  src="/cytactic-logo.png"
                  alt=""
                  className="h-3 w-3 shrink-0"
                  draggable={false}
                />
                Cytactic&rsquo;s Blaze Rush Leaderboard
              </span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {me && (
              <>
                <Link
                  to={`/racer/${me.id}`}
                  className="group flex items-center gap-2.5 border border-hairline bg-white/[0.02] px-2 py-1.5 transition hover:border-plasma/60 sm:px-3"
                  style={{ ['--glow' as string]: me.accentColor }}
                >
                  <Avatar src={me.avatarUrl} name={me.displayName} size={30} accent={me.accentColor} />
                  <span className="hidden min-w-0 text-left sm:block">
                    <span className="block truncate font-display text-[0.7rem] font-bold uppercase tracking-wider text-white">
                      {me.displayName}
                    </span>
                    <span className="block font-mono text-[0.6rem] text-[var(--text-dim)]">
                      {me.scores.allTime} {me.scores.allTime === 1 ? 'win' : 'wins'}
                    </span>
                  </span>
                </Link>
                <button
                  className="btn btn-ghost !px-2.5 !py-2"
                  onClick={() => void logout()}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Desktop rail. */}
      <aside
        className="fixed left-0 z-30 hidden w-[15rem] border-r border-hairline bg-[#06080f]/70 backdrop-blur-lg lg:block 3xl:w-[17rem]"
        style={{
          top: 'calc(var(--ticker-h) + var(--topbar-h))',
          bottom: 0,
        }}
      >
        <SideNav items={nav} />
      </aside>

      {/* Mobile slide-over. */}
      {menuOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          />
          <aside
            className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col border-r border-hairline bg-[#080b16]"
            style={{ animation: 'rise 260ms cubic-bezier(0.16,1,0.3,1) both' }}
          >
            <div className="flex items-center justify-between border-b border-hairline px-4 py-4">
              <span className="headline text-lg">Scrapyard Hard V</span>
              <button
                className="btn btn-ghost !px-2 !py-1.5"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={16} />
              </button>
            </div>
            <SideNav items={nav} />
          </aside>
        </div>
      )}

      {/* Page body. */}
      <main
        className="relative lg:pl-[15rem] 3xl:pl-[17rem]"
        style={{ paddingTop: 'calc(var(--ticker-h) + var(--topbar-h))' }}
      >
        <div className="shell py-6 sm:py-10 3xl:py-14">{children}</div>

        <footer className="shell border-t border-hairline py-8 text-center">
          <p className="label">
            Themed after BlazeRush by Targem Games · Arthur is an original drawing
          </p>
        </footer>
      </main>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Trophy;
  end: boolean;
}

function SideNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 p-3">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `group relative flex items-center gap-3 px-3 py-3 font-display text-[0.7rem] font-bold uppercase tracking-[0.14em] transition-all ${
              isActive
                ? 'text-white'
                : 'text-[var(--text-dim)] hover:bg-white/[0.03] hover:text-white'
            }`
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'linear-gradient(90deg, rgb(255 106 0 / 0.22), transparent)',
                  boxShadow: 'inset 2px 0 0 0 #FF6A00',
                  textShadow: '0 0 14px rgb(255 106 0 / 0.9)',
                }
              : undefined
          }
        >
          <item.icon size={17} className="shrink-0" />
          <span className="truncate">{item.label}</span>
        </NavLink>
      ))}

      <div className="divider-neon my-3" />

      <div className="mt-auto px-3 pb-2">
        <div className="flex items-center gap-2 opacity-40">
          <LayoutGrid size={13} />
          <span className="label text-[0.5rem]">Lo-fi JSON backend</span>
        </div>
      </div>
    </nav>
  );
}

export default AppShell;
