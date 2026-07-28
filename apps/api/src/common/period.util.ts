import type { PeriodKind } from '@scrapyard/shared';

/**
 * All period maths is done in a single configured timezone so that "daily"
 * means the same thing for everyone on the team, regardless of where they are.
 * Defaults to UTC; override with SCRAPYARD_TIMEZONE (an IANA zone).
 *
 * IMPORTANT: the zone is resolved *lazily*, not at module load. `@Module()`
 * decorator arguments are evaluated at require-time, which happens before
 * ConfigModule.forRoot() populates process.env from .env — so reading the
 * variable at the top level would silently always see the UTC default.
 */
let cachedZone: string | null = null;
let cachedDayFormatter: Intl.DateTimeFormat | null = null;
let cachedHourFormatter: Intl.DateTimeFormat | null = null;
let cachedMinuteFormatter: Intl.DateTimeFormat | null = null;

function timezone(): string {
  if (cachedZone === null) {
    cachedZone = process.env.SCRAPYARD_TIMEZONE || 'UTC';
  }
  return cachedZone;
}

function dayFormatter(): Intl.DateTimeFormat {
  if (!cachedDayFormatter) {
    cachedDayFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return cachedDayFormatter;
}

function hourFormatter(): Intl.DateTimeFormat {
  if (!cachedHourFormatter) {
    cachedHourFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone(),
      hour: '2-digit',
      hour12: false,
    });
  }
  return cachedHourFormatter;
}

function minuteFormatter(): Intl.DateTimeFormat {
  if (!cachedMinuteFormatter) {
    cachedMinuteFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone(),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return cachedMinuteFormatter;
}

/** Test/boot hook — forget the cached zone so the next call re-reads env. */
export function resetTimezoneCache(): void {
  cachedZone = null;
  cachedDayFormatter = null;
  cachedHourFormatter = null;
  cachedMinuteFormatter = null;
}

/** 'YYYY-MM-DD' in the configured timezone. */
export function dayKey(date: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what we want.
  return dayFormatter().format(date);
}

/** 'YYYY-MM' in the configured timezone. */
export function monthKey(date: Date = new Date()): string {
  return dayKey(date).slice(0, 7);
}

/**
 * Hour 0–23 in the configured timezone. Used by the after-dark achievement,
 * which must agree with the day boundary rather than the server's own clock.
 */
export function hourOfDay(date: Date): number {
  return Number.parseInt(hourFormatter().format(date), 10);
}

/**
 * Minutes since midnight (0–1439) in the configured timezone. Used by the
 * Happy Hour achievement, whose window (16:30–19:00) needs minute precision.
 */
export function minuteOfDay(date: Date): number {
  // en-GB 24h formats as 'HH:mm'.
  const [hh, mm] = minuteFormatter().format(date).split(':');
  return Number.parseInt(hh, 10) * 60 + Number.parseInt(mm, 10);
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isMonthKey(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

export function periodKindOf(key: string): PeriodKind | null {
  if (key === 'all-time') return 'all-time';
  if (isMonthKey(key)) return 'monthly';
  if (isDayKey(key)) return 'daily';
  return null;
}

/** Filesystem-safe slug for a scoreboard file. */
export function scoreboardSlug(kind: PeriodKind, key: string): string {
  return kind === 'all-time' ? 'all-time' : `${kind}-${key}`;
}

export function periodLabel(kind: PeriodKind, key: string): string {
  if (kind === 'all-time') return 'All Time';
  if (kind === 'monthly') {
    const [year, month] = key.split('-').map(Number);
    const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      timeZone: 'UTC',
    });
    return `${name} ${year}`;
  }
  return key;
}

/** Shift a 'YYYY-MM-DD' key by N days. Pure string/UTC maths, no TZ drift. */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive list of day keys walking backwards from `from`. */
export function recentDayKeys(count: number, from: string = dayKey()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(shiftDayKey(from, -i));
  return out;
}

/** Number of whole days between two day keys (a - b). */
export function dayKeyDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

/** Resolved zone name, for /health. Call after config has loaded. */
export function timezoneName(): string {
  return timezone();
}
