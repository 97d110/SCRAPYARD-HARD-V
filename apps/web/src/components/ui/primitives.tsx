import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
} from 'react';

/* ---------------------------------------------------------------------------
 * Shared UI primitives. Everything accepts an `accent` that drives the CSS
 * `--glow` variable, which is what all the neon effects in index.css read.
 * ------------------------------------------------------------------------- */

export function withGlow(accent?: string): React.CSSProperties {
  return accent ? ({ ['--glow' as string]: accent } as React.CSSProperties) : {};
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  accent?: string;
  /** Draws the lit hairline along the top edge. */
  lit?: boolean;
  tight?: boolean;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { accent, lit = false, tight = false, className = '', style, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`panel ${lit ? 'panel-lit' : ''} ${tight ? 'panel-tight' : ''} ${className}`}
      style={{ ...withGlow(accent), ...style }}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
  accent?: string;
  /** Adds the rotating conic-gradient ring. */
  ring?: boolean;
}

export const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(function NeonButton(
  { variant = 'ghost', accent, ring = false, className = '', style, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn ${variant === 'primary' ? 'btn-primary' : 'btn-ghost'} ${ring ? 'ring-spin' : ''} ${className}`}
      style={{ ...withGlow(accent), ...style }}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Small uppercase caption used above every stat and field. */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`label ${className}`}>{children}</p>;
}

/** Big number + caption block. */
export function Stat({
  label,
  value,
  hint,
  accent,
  className = '',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`} style={withGlow(accent)}>
      <Label>{label}</Label>
      <p className="stat-number neon mt-1 text-[clamp(1.4rem,1rem+1.4vw,2.4rem)] leading-none">
        {value}
      </p>
      {hint && <p className="mt-1 truncate text-[0.7rem] text-[var(--text-faint)]">{hint}</p>}
    </div>
  );
}

/**
 * Avatar with a neon rim. Falls back to initials on a tinted plate when the
 * user has no picture (seeded users, or a Google account with no photo).
 */
export function Avatar({
  src,
  name,
  size = 40,
  accent = '#00E5FF',
  rank,
  className = '',
  artwork = false,
  vehicle,
  vehicleScale = 0.6,
}: {
  src?: string;
  name: string;
  size?: number;
  accent?: string;
  /** Renders a rank pip in the corner. */
  rank?: number;
  className?: string;
  /**
   * True when `src` is character art rather than a photo.
   *
   * Photos are square-ish and want `cover` — filling the circle, cropping the
   * edges. Character art is a tall transparent cut-out, and `cover` would zoom
   * it until the head left the frame. So it gets `contain`, sat on the tinted
   * plate the initials fallback already uses, and anchored to the bottom so the
   * character stands on the circle rather than floating in it.
   *
   * `contain` stays correct for the racers whose art is a square head-shot
   * rather than a full-body cut-out, because those are squared when the asset is
   * cut — a square image in this square box has nothing left to letterbox. That
   * is deliberate and it is load-bearing: leaving the head-shots at their native
   * 119x116 left a 3px black sliver along the top of the circle, which
   * `object-bottom` guarantees lands somewhere visible. See PORTRAIT_SLOT in
   * scripts/build-racer-art.mjs.
   */
  artwork?: boolean;
  /** Vehicle art for the corner badge. Opt-in per call site — see vehicleScale. */
  vehicle?: string | null;
  /**
   * Vehicle size as a fraction of the avatar.
   *
   * Per call site rather than one global number, because a badge legible at
   * 112px is a smudge at 34px. 0.6 by default — the profile hero and editor
   * preview — 0.3 on podium places, and no vehicle at all on list avatars: a
   * decision the caller makes explicitly, so the car can't silently appear when
   * someone adjusts an avatar's size.
   */
  vehicleScale?: number;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-visible ${className}`}
      style={{ width: size, height: size, ...withGlow(accent) }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 210deg, ${accent}, transparent 55%, ${accent})`,
          padding: 2,
          filter: 'saturate(1.2)',
        }}
      />
      {src ? (
        <img
          src={src}
          alt={name}
          width={size}
          height={size}
          loading="lazy"
          className={`relative z-10 rounded-full ${artwork ? 'object-contain object-bottom' : 'object-cover'}`}
          style={{
            width: size - 4,
            height: size - 4,
            boxShadow: `0 0 18px -4px ${accent}`,
            // Art is a transparent cut-out, so it needs the same tinted plate
            // the initials fallback sits on — otherwise it floats on whatever
            // happens to be behind the avatar.
            background: artwork
              ? `radial-gradient(circle at 30% 25%, ${accent}44, #0d1122 70%)`
              : '#0d1122',
          }}
        />
      ) : (
        <span
          className="relative z-10 grid place-items-center rounded-full font-display font-black text-white"
          style={{
            width: size - 4,
            height: size - 4,
            fontSize: Math.max(10, size * 0.36),
            background: `radial-gradient(circle at 30% 25%, ${accent}44, #0d1122 70%)`,
            boxShadow: `0 0 18px -4px ${accent}`,
          }}
        >
          {initials || '?'}
        </span>
      )}
      {/*
        The car, bottom-LEFT. The rank pip below holds bottom-right, so the two
        can share an avatar on the podium without overlapping.
      */}
      {vehicle && (
        <img
          src={vehicle}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="pointer-events-none absolute bottom-0 left-0 z-20 object-contain"
          style={{
            /*
             * A SQUARE box, with object-contain fitting each car inside it.
             * The art's aspect ratio varies from 1.0 (Beast) to 1.6 (Turboboy),
             * so a fixed wide box would size the squarer cars by height and
             * leave them floating off-centre in dead space.
             */
            width: Math.round(size * vehicleScale),
            height: Math.round(size * vehicleScale),
            /*
             * Hangs off the rim so it reads as a badge ON the circle rather
             * than something trapped inside it. Equal X and Y so it travels
             * along the diagonal, which is the only direction where pushing it
             * out doesn't eat into the portrait's silhouette.
             */
            transform: 'translate(-28%, 28%)',
            /*
             * A light-grey rim, then a dark lift.
             *
             * `drop-shadow` follows the alpha edge rather than the box, so on a
             * cut-out it traces the car's actual silhouette — which is what
             * separates it from the character art directly behind. Grey rather
             * than white so the rim reads as an outline instead of a glow; the
             * cars themselves have white highlights that pure #fff bled into.
             *
             * Applied twice because each shadow operates on the previous one's
             * result, and one pass is too thin to read against busy artwork.
             */
            filter:
              'drop-shadow(0 0 1.5px #b9c0d0) drop-shadow(0 0 1.5px #b9c0d0) drop-shadow(0 2px 4px rgb(0 0 0 / 0.7))',
          }}
        />
      )}
      {rank !== undefined && rank <= 3 && (
        <span
          className="absolute -bottom-1 -right-1 z-20 grid h-[18px] w-[18px] place-items-center rounded-full font-display text-[9px] font-black text-black"
          style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
        >
          {rank}
        </span>
      )}
    </span>
  );
}

/** Segmented control used for the leaderboard period tabs. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accent = '#FF6A00',
  className = '',
}: {
  options: Array<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (value: T) => void;
  accent?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`no-scrollbar flex gap-1 overflow-x-auto border border-hairline bg-[#070a14] p-1 ${className}`}
      style={withGlow(accent)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={`relative flex-1 whitespace-nowrap px-3 py-2 font-display text-[0.65rem] font-bold uppercase tracking-[0.16em] transition-all sm:px-5 sm:text-xs ${
              selected ? 'text-white' : 'text-[var(--text-dim)] hover:text-white'
            }`}
            style={
              selected
                ? {
                    background: `linear-gradient(180deg, ${accent}33, ${accent}14)`,
                    boxShadow: `inset 0 0 0 1px ${accent}66, 0 0 24px -10px ${accent}`,
                    textShadow: `0 0 12px ${accent}`,
                  }
                : undefined
            }
          >
            {option.label}
            {option.hint && (
              <span className="ml-2 hidden font-mono text-[0.6rem] opacity-60 sm:inline">
                {option.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Full-bleed loading state — a spinning boost ring. */
export function LoadingRig({ label = 'Warming up the grid' }: { label?: string }) {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="text-center">
        <div className="relative mx-auto h-20 w-20">
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-blaze border-r-magenta" />
          <span
            className="absolute inset-3 animate-spin rounded-full border-2 border-transparent border-b-plasma border-l-toxic"
            style={{ animationDirection: 'reverse', animationDuration: '1.4s' }}
          />
        </div>
        <p className="label mt-5 animate-pulse">{label}</p>
      </div>
    </div>
  );
}

/** Inline error plate. */
export function ErrorPlate({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Panel accent="#FF3B30" lit className="mx-auto max-w-lg p-6 text-center">
      <Label>Something blew up</Label>
      <p className="mt-2 text-sm text-[var(--text)]">{message}</p>
      {onRetry && (
        <NeonButton variant="ghost" accent="#FF3B30" className="mt-4" onClick={onRetry}>
          Try again
        </NeonButton>
      )}
    </Panel>
  );
}
