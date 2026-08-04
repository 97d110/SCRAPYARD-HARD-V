import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ArrowRight, Menu, Shield, Trophy, Users, X } from 'lucide-react';
import { useApp } from '../../state/AppStore';
import { useLiveStatus } from '../../state/useLiveEvent';
import type { LiveStatus } from '../../lib/live';
import type { PublicUser } from '@scrapyard/shared';
import { PunTicker } from '../PunTicker';
import { FinishFlourish } from '../celebration/FinishFlourish';
import { ArthurShipFx } from '../arthur/ArthurShipFx';
import { Avatar } from '../ui/primitives';
import { RACE_COLOR_HEX } from '../../lib/raceColors';
import { avatarFor } from '../../lib/racerArt';

/**
 * The chrome every page sits inside: pun ticker at the very top, then the
 * top bar, then a side menu (permanent rail on desktop, slide-over on mobile).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, puns, celebration, clearCelebration } = useApp();
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
    ...(me?.role === 'admin'
      ? [{ to: '/admin', label: 'Admin', icon: Shield, end: false }]
      : []),
  ];

  return (
    <div className="relative min-h-screen">
      {/* The finish crest's victory lap, launched from anywhere in the app. */}
      <FinishFlourish
        runId={celebration?.id ?? null}
        accent={celebration?.accent}
        caption={celebration?.caption}
        onDone={clearCelebration}
      />

      {/* Top prompter. The Cytactic mark lives inside it now, as a normal
          child sharing the bar rather than floating above it.

          The padding is the iOS notch: installed to a home screen with
          `viewport-fit=cover` and a translucent status bar, the top of the
          viewport is *under* the clock, and without this the ticker would be
          too. `--safe-top` is 0px everywhere else. */}
      <div className="fixed inset-x-0 top-0 z-50" style={{ paddingTop: 'var(--safe-top)' }}>
        <PunTicker puns={puns} />
      </div>

      {/* Top bar. */}
      <header
        className="fixed inset-x-0 z-40 border-b border-hairline bg-[#06080f]/85 backdrop-blur-xl"
        style={{ top: 'calc(var(--ticker-h) + var(--safe-top))', height: 'var(--topbar-h)' }}
      >
        {/* Full-bleed on purpose, not `.shell` — on a wide desktop screen the
            title bar should run to the edges rather than sit capped/centred
            the way the page content below it does. Same padding formula as
            `.shell` though, so the left inset still starts at a sane place. */}
        <div
          className="flex h-full w-full items-center gap-3"
          style={{ paddingInline: 'clamp(1rem, 0.5rem + 2vw, 3rem)' }}
        >
          <button
            className="btn btn-ghost !px-2.5 !py-2 lg:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>

          <Link to="/" className="group flex min-w-0 items-center gap-3">
            {/* Desktop only — on a narrow bar this is exactly what was
                crowding the title into a truncated "SCRAPYA...". */}
            <ArthurShipFx
              size={56}
              accent="#FF6A00"
              className="hidden transition-transform group-hover:scale-110 lg:inline-flex"
            />
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

          {/*
            The whole right-hand side of the bar is now just this. The account
            badge moved into the side menu, where it sits next to the navigation
            it belongs with; sign-out moved to the bottom of your own profile
            page, which is the one place it can't be hit by accident while
            reaching for something else.
          */}
          <LiveIndicator />
        </div>
      </header>

      {/* Desktop rail. Account card on top, then the navigation — the same
          order as the mobile slide-over, so the two read as one menu that
          happens to be pinned open on a wide screen. */}
      <aside
        className="fixed left-0 z-30 hidden w-[15rem] flex-col border-r border-hairline bg-[#06080f]/70 backdrop-blur-lg lg:flex 3xl:w-[17rem]"
        style={{
          top: 'var(--chrome-h)',
          bottom: 0,
        }}
      >
        {me && <AccountCard me={me} />}
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
            style={{
              animation: 'rise 260ms cubic-bezier(0.16,1,0.3,1) both',
              // Clears the notch and the home affordance in a standalone window.
              paddingTop: 'var(--safe-top)',
              paddingBottom: 'var(--safe-bottom)',
            }}
          >
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
              <ArthurShipFx size={80} accent="#FF6A00" />
              <button
                className="btn btn-ghost !px-2 !py-1.5"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={16} />
              </button>
            </div>

            {me && <AccountCard me={me} />}

            {/* No sign-out down here any more. It lives at the bottom of your
                own profile page — one place, on both layouts, and not a
                full-width button sitting under a menu you opened to navigate. */}
            <SideNav items={nav} />
          </aside>
        </div>
      )}

      {/* Page body. */}
      <main
        className="relative lg:pl-[15rem] 3xl:pl-[17rem]"
        style={{ paddingTop: 'var(--chrome-h)' }}
      >
        {/* The bottom inset is the iOS home-affordance bar; without it the last
            row of a board sits underneath it in a standalone window. */}
        <div
          className="shell py-6 sm:py-10 3xl:py-14"
          style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Your own badge: avatar, name, win count, and the way to your profile.
 *
 * One component, mounted twice — top of the desktop rail and top of the mobile
 * slide-over. It used to be duplicated for the two, which is how the two copies
 * drifted apart in the first place.
 *
 * The arrow is explicit because this is the only route to your own profile:
 * there is no "My Profile" nav item, and since sign-out moved onto that page,
 * this is also the only route to signing out.
 */
function AccountCard({ me }: { me: PublicUser }) {
  return (
    <div className="border-b border-hairline p-3">
      <Link
        to={`/racer/${me.id}`}
        className="group flex items-center gap-3 border border-hairline bg-white/[0.02] px-3 py-2.5 transition hover:border-plasma/60"
        style={{ ['--glow' as string]: RACE_COLOR_HEX[me.raceColor] }}
      >
        <Avatar {...(({ src, isRacerArt }) => ({ src, artwork: isRacerArt }))(avatarFor(me))} name={me.displayName} size={36} accent={RACE_COLOR_HEX[me.raceColor]} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-display text-xs font-bold uppercase tracking-wider text-white">
            {me.displayName}
          </span>
          <span className="block font-mono text-[0.65rem] text-[var(--text-dim)]">
            {me.scores.allTime} {me.scores.allTime === 1 ? 'win' : 'wins'}
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-[var(--text-dim)] transition-all group-hover:translate-x-0.5 group-hover:text-white"
        />
      </Link>
    </div>
  );
}

/** What each connection state means, in words, for the tooltip. */
const LIVE_DETAIL: Record<LiveStatus, string> = {
  live: 'Listening — races recorded by anyone show up here straight away.',
  connecting: 'Reconnecting to the live channel…',
  offline: 'Not connected. This board may be out of date.',
};

/**
 * Whether this tab is currently being told about other people's races.
 *
 * Worth a permanent place in the chrome rather than a transient toast: on a wall
 * display, "the board hasn't changed in a while" and "this tab stopped
 * listening an hour ago" look identical, and only one of them is fine.
 *
 * State is carried by the label and by the dot being filled or hollow, so it
 * doesn't depend on telling two colours apart. Below `sm` the label hides — that
 * space is what the title needs — which leaves a bare dot whose meaning isn't
 * obvious, and a `title` a touch screen will never show. Hence the button: tap
 * it and it says what it's doing.
 */
function LiveIndicator() {
  const status = useLiveStatus();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const { label, filled, accent } =
    status === 'live'
      ? { label: 'Live', filled: true, accent: 'var(--plasma)' }
      : status === 'connecting'
        ? { label: 'Syncing', filled: false, accent: 'var(--text-dim)' }
        : { label: 'Offline', filled: false, accent: 'var(--text-faint)' };

  // A tooltip, not a dialog: it takes itself away. Re-armed on a status change
  // so the message you're reading is never one state behind.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), 3200);
    return () => window.clearTimeout(timer);
  }, [open, status]);

  // Tapping anywhere else dismisses it, which on a phone is the gesture people
  // reach for before they look for a close button.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative ml-auto shrink-0">
      <button
        type="button"
        className="flex items-center gap-1.5 border border-hairline bg-white/[0.02] px-2 py-1.5 transition hover:border-plasma/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        // Announced on change, which is the point — this is the one piece of
        // chrome whose state matters without anyone looking at it.
        aria-live="polite"
        aria-label={`Live updates: ${label}`}
        // Pointless on a touch screen, still welcome on a desktop hover.
        title={LIVE_DETAIL[status]}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full border ${status === 'connecting' ? 'animate-pulse' : ''}`}
          style={{
            borderColor: accent,
            background: filled ? accent : 'transparent',
            boxShadow: filled ? `0 0 8px ${accent}` : undefined,
          }}
        />
        <span
          className="hidden font-display text-[0.55rem] font-bold uppercase tracking-[0.16em] sm:inline"
          style={{ color: accent }}
        >
          {label}
        </span>
      </button>

      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          /* Right-anchored because this is the last thing in the bar, so a
             left-anchored bubble would run off the edge on a narrow screen. */
          className="panel panel-tight absolute right-0 top-full z-10 mt-2 block w-max max-w-[min(17rem,72vw)] px-3 py-2 text-left text-[0.7rem] leading-snug text-[var(--text)]"
          style={{ ['--glow' as string]: accent, animation: 'rise 160ms ease-out both' }}
        >
          {LIVE_DETAIL[status]}
        </span>
      )}
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
    </nav>
  );
}

export default AppShell;
