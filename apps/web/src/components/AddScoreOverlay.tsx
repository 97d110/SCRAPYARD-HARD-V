import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Crown,
  GripVertical,
  Loader2,
  Mic,
  Plus,
  Search,
  Skull,
  Trophy,
  X,
} from 'lucide-react';
import { Avatar, Label, NeonButton, Panel, withGlow } from './ui/primitives';
import { api } from '../lib/api';
import { recordAudio, speechSupported, type RecordingSession } from '../lib/speech';
import type { GameResultInput, KillEventInput, MetricDef, PublicUser } from '@scrapyard/shared';
import { RACE_COLOR_HEX } from '../lib/raceColors';
import { RacerStats, statsFromUser } from './RacerStats';
import { avatarFor } from '../lib/racerArt';

/**
 * The race-entry overlay.
 *
 *   desktop  a two-pane workspace, everything visible at once: racer picker on
 *            the left, the grid + kill log + note on the right.
 *   mobile   a three-step wizard — racers, then the grid, then the optional
 *            extras — because all of that at once on a phone is exactly what
 *            crews were tripping over. Each step is full-screen with one job,
 *            and a sticky footer carries you to the next.
 *
 * A winner alone is a valid race; everything past first place is optional.
 * Submit still puts on the full show and hands off to Arthur's flyby.
 */

/** Per-racer draft. Numbers are held as strings so the inputs stay controlled. */
interface Finisher {
  racerId: string;
  gameScore: string;
  /** Captured metric values, keyed by metric id. Blank reads as 0. */
  stats: Record<string, string>;
}

/** Medal tint by finishing place (1-indexed). Beyond the podium goes faint. */
const PLACE_COLOR = ['#FFB020', '#CFE3FF', '#FF8A3D', '#5b6688'];

/**
 * The scoring ground rules — mirrored from the server (`ScoresService.validate`)
 * so the overlay can validate and preview them live, without waiting on a
 * round trip. Kept in sync deliberately; if the server's numbers change, these
 * must too.
 */
const DEFAULT_SCORE_BY_PLACE = [15, 10, 5, 0];
const WINNER_MIN_SCORE = 15;

/**
 * What a finisher's score actually resolves to on SUBMIT: blank falls back to
 * the standard purse for that place, and the winner's purse is topped up to the
 * minimum.
 *
 * Not used for validation — see `enteredScores`. The top-up would hide the
 * mistake being validated for, so by the time this runs the grid has already
 * been proven clean and the floor only ever applies to a blank box. The server
 * applies the same floor independently (ScoresService.validate).
 */
function effectiveScore(raw: string, place: number): number {
  const typed = raw.trim() === '' ? 0 : Math.max(0, Number(raw) || 0);
  let score = typed === 0 ? DEFAULT_SCORE_BY_PLACE[place - 1] ?? 0 : typed;
  if (place === 1 && score < WINNER_MIN_SCORE) score = WINNER_MIN_SCORE;
  return score;
}

/** Matches Tailwind's `lg` breakpoint — the same one the rest of the app treats as "desktop". */
const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * Desktop gets the simultaneous two-pane layout; anything narrower gets the
 * step wizard. A media query rather than a CSS-only show/hide split, because
 * the two layouts don't just restyle the same markup — mobile shows one
 * step's content at a time, so only one tree can be mounted, not two with one
 * hidden (which would mean two `<input>`s fighting over one drag ref).
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(query.matches);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

type Step = 'racers' | 'grid' | 'extra';
const STEPS: Step[] = ['racers', 'grid', 'extra'];

/**
 * What to call the bit where a model thinks about it.
 *
 * Invented gerunds on purpose: the honest label would be "waiting on two model
 * calls of unknown length", which is neither short nor fun to read. One is
 * picked at random per run, so the wait feels like the app doing something
 * rather than the app having stalled.
 */
const VOICE_WORDS = [
  'Transfigurelating',
  'Untangling the shouting',
  'Deciphering the yelling',
  'Unscrambling names',
  'Divining placements',
  'Parsing the pandemonium',
  'Wrangling syllables',
  'Consulting the scrapyard',
  'Translating enthusiasm',
  'Sifting the commotion',
  'Interrogating the audio',
  'Reticulating racers',
] as const;

/**
 * One line of the voice-entry progress flow.
 *
 * Three visual states, and the icon carries the meaning rather than colour
 * alone: a tick for finished, a spinner for in flight, a hollow ring for
 * not-yet. The connecting stub between rows is what makes three separate lines
 * read as one sequence instead of a list.
 */
function FlowStep({
  state,
  label,
  last = false,
}: {
  state: 'done' | 'active' | 'pending';
  label: string;
  last?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex flex-col items-center">
        <span className="grid h-4 w-4 shrink-0 place-items-center">
          {state === 'done' ? (
            <Check size={13} className="text-toxic" strokeWidth={3} />
          ) : state === 'active' ? (
            <Loader2 size={13} className="animate-spin text-plasma" />
          ) : (
            <span className="h-2 w-2 rounded-full border border-[var(--text-faint)]" />
          )}
        </span>
        {!last && (
          <span
            className={`my-0.5 w-px flex-1 ${state === 'done' ? 'bg-toxic/40' : 'bg-hairline'}`}
            style={{ minHeight: '0.5rem' }}
          />
        )}
      </span>
      <span
        className={`font-mono text-[0.68rem] leading-4 ${
          state === 'pending' ? 'text-[var(--text-faint)]' : 'text-[var(--text-dim)]'
        } ${!last ? 'pb-1.5' : ''}`}
      >
        {label}
      </span>
    </div>
  );
}

export function AddScoreOverlay({
  open,
  users,
  onClose,
  onSubmit,
}: {
  open: boolean;
  users: PublicUser[];
  onClose: () => void;
  /** Resolve to launch the celebration; reject to show the error. */
  onSubmit: (results: GameResultInput[], events: KillEventInput[], note?: string) => Promise<unknown>;
}) {
  const isDesktop = useIsDesktop();
  const [query, setQuery] = useState('');
  const [finishers, setFinishers] = useState<Finisher[]>([]);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<'idle' | 'charging' | 'launched'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Captured metrics drive one numeric input per racer. Fetched on open.
  const [captured, setCaptured] = useState<MetricDef[]>([]);
  // The kill log — killer→victim pairs. Drives kills/deaths and revenge.
  const [kills, setKills] = useState<KillEventInput[]>([]);
  const [killer, setKiller] = useState('');
  const [victim, setVictim] = useState('');
  // Mobile only: which step of the wizard is showing. Irrelevant on desktop,
  // where every section is visible at once.
  const [step, setStep] = useState<Step>('racers');
  // Plays the collapse animation before the parent unmounts us.
  const [closing, setClosing] = useState(false);
  // The finisher row currently being dragged, for reorder + visual feedback.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragPointerId = useRef<number | null>(null);

  /*
   * Voice entry. `voiceReady` is null until the server has been asked whether
   * the feature is configured at all — the mic renders only on a definite yes,
   * so an unconfigured deployment never shows a button that can't work.
   *
   * `heardBy` keeps what was spoken for each racer the extractor placed. With
   * no separate review step by design, that mapping is the only way someone
   * spots "heard יוסי, filled in Dana", so it rides along on the grid rows.
   */
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);
  /*
   * One state machine rather than a booleans-per-stage set, because the stages
   * are mutually exclusive by nature and separate flags would let impossible
   * combinations exist (recording AND working) that the UI would then have to
   * decide between.
   */
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'working' | 'done'>('idle');
  /** Picked once per run so it doesn't reshuffle mid-spin. */
  const [workingWord, setWorkingWord] = useState<string>(VOICE_WORDS[0]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [heardBy, setHeardBy] = useState<Record<string, string>>({});
  const sessionRef = useRef<RecordingSession | null>(null);
  const doneTimer = useRef<number | null>(null);

  const listening = voicePhase === 'recording';
  const voiceBusy = voicePhase === 'working';

  /**
   * Close with the collapse animation: mark closing, then unmount (via the
   * parent's onClose) once it has played. A launch is already running its own
   * exit, so leave that alone.
   */
  const requestClose = useCallback(() => {
    if (phase !== 'idle') return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [phase, onClose]);

  // Reset every time the overlay opens so it never resumes a stale state.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFinishers([]);
    setNote('');
    setPhase('idle');
    setError(null);
    setKills([]);
    setKiller('');
    setVictim('');
    setStep('racers');
    setDragIndex(null);
    setClosing(false);
    setVoicePhase('idle');
    if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    setVoiceError(null);
    setVoiceNote(null);
    setHeardBy({});
    const timer = window.setTimeout(() => searchRef.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, [open]);

  /*
   * Is voice entry usable at all? Two independent gates: the browser has to
   * implement speech recognition, and the server has to have a key configured.
   * Asked once per open, and a failed check reads as "off" rather than throwing
   * — the overlay's job is recording races, not reporting on optional extras.
   */
  useEffect(() => {
    if (!open) return;
    if (!speechSupported()) {
      setVoiceReady(false);
      return;
    }
    let live = true;
    api.voice
      .status()
      .then((result) => {
        if (live) setVoiceReady(result.available);
      })
      .catch(() => {
        if (live) setVoiceReady(false);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Never leave the microphone live past the overlay closing.
  useEffect(() => {
    if (open) return;
    sessionRef.current?.cancel();
    sessionRef.current = null;
    if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
  }, [open]);

  // A kill can only involve racers still on the grid — drop any whose killer or
  // victim was removed, so the log can never reference a car that isn't racing.
  useEffect(() => {
    const ids = new Set(finishers.map((f) => f.racerId));
    setKills((prev) => prev.filter((k) => ids.has(k.killerId) && ids.has(k.victimId)));
    // Same for the "heard as" labels: swapping a mis-matched racer out should
    // take the stale transcript note with them, not leave it on the new row.
    setHeardBy((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [finishers]);

  // The captured-metric list only changes when an admin edits it, so a fetch
  // per open is cheap and keeps the form honest without a store subscription.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .metrics()
      .then((metrics) => {
        // kills/deaths are derived from the kill log, so no typed input for them.
        if (live) {
          setCaptured(metrics.filter((m) => m.kind === 'captured' && m.id !== 'kills' && m.id !== 'deaths'));
        }
      })
      .catch(() => {
        // A missing metric list just means no stat inputs — the race still records.
        if (live) setCaptured([]);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Escape closes, unless we're mid-launch.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, requestClose]);

  /**
   * Listen, extract, fill. Replaces the grid outright rather than merging into
   * it: someone describing a whole race means "this is the race", and merging
   * would silently blend a correction into the mistake it was correcting.
   *
   * Everything it produces is an ordinary editable value — the placement order,
   * the scores, the racers themselves — and nothing is recorded until Add Score
   * is pressed by hand as usual.
   */
  const runVoiceEntry = async () => {
    if (phase !== 'idle' || voicePhase !== 'idle') return;
    if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    setVoiceError(null);
    setVoiceNote(null);
    setVoicePhase('recording');

    let audio: string;
    try {
      const { session, result } = recordAudio();
      sessionRef.current = session;
      audio = await result;
    } catch (caught) {
      setVoicePhase('idle');
      sessionRef.current = null;
      // "Cancelled." is the person's own doing — not worth an error message.
      const message = caught instanceof Error ? caught.message : 'Could not record.';
      if (message !== 'Cancelled.') setVoiceError(message);
      return;
    }

    sessionRef.current = null;
    setWorkingWord(VOICE_WORDS[Math.floor(Math.random() * VOICE_WORDS.length)]);
    setVoicePhase('working');
    try {
      const draft = await api.voice.draft(audio);

      if (draft.finishers.length === 0) {
        setVoiceError(
          draft.unmatched.length > 0
            ? `Heard ${draft.unmatched.join(', ')} — nobody on the roster matches. Add their Hebrew name in their profile.`
            : "Couldn't pick out any racers from that. Try naming them one by one.",
        );
        setVoicePhase('idle');
        return;
      }

      setFinishers(
        draft.finishers.map((row) => ({
          racerId: row.racerId,
          gameScore: row.gameScore === null ? '' : String(row.gameScore),
          stats: {},
        })),
      );
      setHeardBy(Object.fromEntries(draft.finishers.map((row) => [row.racerId, row.heardAs])));

      // Partial success is still success, but it must be visible: a racer who
      // was said and silently dropped is the one mistake nobody would catch.
      if (draft.unmatched.length > 0) {
        setVoiceNote(
          `Couldn't place ${draft.unmatched.join(', ')} — add them below, or set their Hebrew name in their profile.`,
        );
      }
      /*
       * Land on the grid, but only on success. It's where everything voice just
       * produced lives — the rows, the scores, the "heard as" labels and any
       * validation flag — so reviewing it is the natural next move. A failure
       * stays put: the picker is where you'd fix things by hand, and the error
       * message lives there too.
       *
       * Desktop shows both panes at once, so this is a no-op there.
       */
      setStep('grid');
      setVoicePhase('done');
      // Long enough to register as finished, short enough not to sit in the way
      // of the grid it just filled.
      doneTimer.current = window.setTimeout(() => setVoicePhase('idle'), 1800);
    } catch (caught) {
      setVoiceError(caught instanceof Error ? caught.message : 'Could not read that.');
      setVoicePhase('idle');
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Last race → races total → wins → name. Recency-first: who's actually
    // likely still at the table beats who's historically best, which is what
    // matters when you're picking racers for the race that just happened.
    // Racers who've never raced have no `lastRaceAt` and sink to the bottom.
    const sorted = [...users].sort((a, b) => {
      const aLast = a.scores.lastRaceAt ? Date.parse(a.scores.lastRaceAt) : -Infinity;
      const bLast = b.scores.lastRaceAt ? Date.parse(b.scores.lastRaceAt) : -Infinity;
      return (
        bLast - aLast ||
        b.scores.races - a.scores.races ||
        b.scores.allTime - a.scores.allTime ||
        a.displayName.localeCompare(b.displayName)
      );
    });
    if (!needle) return sorted;
    return sorted.filter(
      (user) =>
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        user.favoriteRacer.toLowerCase().includes(needle),
    );
  }, [users, query]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  /** Toggle a racer in or out of the field. New racers join at the back. */
  const toggleRacer = (racerId: string) => {
    if (phase !== 'idle') return;
    setError(null);

    /*
     * Clear the search once someone has been picked, so the roster is whole
     * again for the next name — a filtered list is only useful up to the moment
     * you've found who you were looking for. Decided out here rather than inside
     * the updater below, both because a state setter shouldn't have side effects
     * and because this must only fire on ADD: clearing the search when someone
     * taps the X to remove a racer would be unprompted and confusing.
     */
    const alreadyRacing = finishers.some((f) => f.racerId === racerId);
    if (!alreadyRacing && finishers.length < 4) setQuery('');

    setFinishers((prev) => {
      const existing = prev.findIndex((f) => f.racerId === racerId);
      if (existing !== -1) return prev.filter((f) => f.racerId !== racerId);
      if (prev.length >= 4) return prev; // a race tops out at four cars
      return [...prev, { racerId, gameScore: '', stats: {} }];
    });
  };

  const move = (index: number, direction: -1 | 1) => {
    if (phase !== 'idle') return;
    setFinishers((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  /** Move a finisher from one slot to another — the placement is the row order. */
  const reorder = (from: number, to: number) => {
    if (phase !== 'idle' || from === to) return;
    setFinishers((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  /*
   * Pointer-based drag reorder — Pointer Events fire identically for mouse and
   * touch, so this works on phones where native HTML5 drag-and-drop does not.
   * The grip captures the pointer, and each move re-homes the dragged row to
   * whichever slot the pointer is over (by the rows' vertical midpoints).
   */
  const beginDrag = (index: number, event: ReactPointerEvent) => {
    if (phase !== 'idle') return;
    dragPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragIndex(index);
  };

  const dragOverMove = (event: ReactPointerEvent) => {
    if (dragIndex === null || !gridRef.current) return;
    const rows = Array.from(gridRef.current.children) as HTMLElement[];
    let target = rows.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (target === -1) target = rows.length - 1;
    if (target !== dragIndex) {
      reorder(dragIndex, target);
      setDragIndex(target);
    }
  };

  const endDrag = (event: ReactPointerEvent) => {
    const id = dragPointerId.current;
    if (id !== null) {
      try {
        event.currentTarget.releasePointerCapture?.(id);
      } catch {
        // Pointer already released — nothing to do.
      }
    }
    dragPointerId.current = null;
    setDragIndex(null);
  };

  const setGameScore = (racerId: string, value: string) => {
    setFinishers((prev) =>
      prev.map((f) => (f.racerId === racerId ? { ...f, gameScore: value } : f)),
    );
  };

  const setStat = (racerId: string, metricId: string, value: string) => {
    setFinishers((prev) =>
      prev.map((f) =>
        f.racerId === racerId ? { ...f, stats: { ...f.stats, [metricId]: value } } : f,
      ),
    );
  };

  const winner = finishers[0] ? usersById.get(finishers[0].racerId) ?? null : null;
  const accent = winner ? RACE_COLOR_HEX[winner.raceColor] : '#FF6A00';

  // Client-side gate, mirroring the server DTO. A winner alone is enough;
  // scores are optional (a blank reads as 0). Only a *typed* score has to be a
  // valid non-negative number. Places are always unique 1..N by construction.
  const scoresValid = finishers.every((f) => {
    if (f.gameScore.trim() === '') return true;
    const n = Number(f.gameScore);
    return Number.isFinite(n) && n >= 0;
  });

  // What actually gets submitted per finisher, after defaults + the winner
  // floor — computed once so validation and submission never disagree.
  const effectiveScores = useMemo(
    () => finishers.map((f, i) => effectiveScore(f.gameScore, i + 1)),
    [finishers],
  );

  /**
   * What's actually in the boxes: a blank still falls back to the place's
   * standard purse, but a number that IS there is taken at face value.
   *
   * Validation reads this rather than `effectiveScores`, and the difference is
   * load-bearing. The winner floor in `effectiveScore` rewrites a low first
   * place up to the minimum, which quietly repaired the very mistake worth
   * catching: a winner recorded as 2 became 15, so the ordering check compared
   * 15 against the runner-up and found nothing wrong. Typed by hand that
   * rewrite was a convenience; produced by a speech model it turns a misheard
   * number into a plausible one and submits it unchallenged.
   */
  const enteredScores = useMemo(
    () =>
      finishers.map((f, i) => {
        const raw = f.gameScore.trim();
        if (raw === '') return DEFAULT_SCORE_BY_PLACE[i] ?? 0;
        return Math.max(0, Number(raw) || 0);
      }),
    [finishers],
  );

  /**
   * Everything wrong with the grid's scores, keyed by the racer whose row needs
   * fixing. One map for both rules so the row highlight, the banner and the
   * proceed gate can't disagree about whether there's a problem.
   */
  const scoreOrderIssues = useMemo(() => {
    const issues = new Map<string, string>();
    const nameOf = (i: number) =>
      usersById.get(finishers[i]?.racerId ?? '')?.displayName ?? 'This racer';

    // A winner below the floor is flagged, not corrected. Only when a number was
    // actually entered — a blank legitimately means "use the standard purse".
    if (finishers.length > 0 && finishers[0].gameScore.trim() !== '') {
      if (enteredScores[0] < WINNER_MIN_SCORE) {
        issues.set(
          finishers[0].racerId,
          `${nameOf(0)} won, so ${enteredScores[0]} can't be right — a win scores at least ${WINNER_MIN_SCORE}. Check what was heard.`,
        );
      }
    }

    // Lower places must score the same or less than the place ahead of them —
    // ties are fine, an increase isn't.
    for (let i = 1; i < finishers.length; i += 1) {
      if (enteredScores[i] > enteredScores[i - 1]) {
        issues.set(
          finishers[i].racerId,
          `${nameOf(i)} (P${i + 1}) can't outscore ${nameOf(i - 1)} (P${i}) — lower places must score the same or less.`,
        );
      }
    }
    return issues;
  }, [finishers, enteredScores, usersById]);

  // Step 1 → 2: at least a winner. Step 2 → 3: the grid has to be valid —
  // there's no point reaching the kill log with a broken score order.
  const canProceedPastRacers = finishers.length >= 1;
  const canProceedPastGrid = scoresValid && scoreOrderIssues.size === 0;
  const canSubmit = canProceedPastRacers && finishers.length <= 4 && canProceedPastGrid;

  const addKill = () => {
    const ids = new Set(finishers.map((f) => f.racerId));
    if (!killer || !victim || killer === victim || !ids.has(killer) || !ids.has(victim)) return;
    setKills((prev) => [...prev, { killerId: killer, victimId: victim }]);
    setKiller('');
    setVictim('');
  };

  const removeKill = (index: number) => setKills((prev) => prev.filter((_, i) => i !== index));

  const submit = async () => {
    if (!canSubmit || phase !== 'idle') return;
    setError(null);
    setPhase('charging');

    const results: GameResultInput[] = finishers.map((finisher, index) => {
      // Only carry captured stats that were actually typed; the server treats
      // absent keys as 0, so there's no need to send a wall of zeros.
      const stats: Record<string, number> = {};
      for (const metric of captured) {
        const raw = finisher.stats[metric.id];
        if (raw !== undefined && raw.trim() !== '') {
          const value = Number(raw);
          if (Number.isFinite(value)) stats[metric.id] = Math.max(0, value);
        }
      }
      return {
        racerId: finisher.racerId,
        place: index + 1,
        gameScore: effectiveScores[index],
        stats,
      };
    });

    // Let the charge animation actually be seen before the request lands.
    const minimumCharge = new Promise((resolve) => window.setTimeout(resolve, 620));

    try {
      const [result] = await Promise.all([onSubmit(results, kills, note || undefined), minimumCharge]);
      void result;
      setPhase('launched');
      // Close just after the flyby starts, so Arthur flies over the leaderboard.
      window.setTimeout(onClose, 420);
    } catch (caught) {
      setPhase('idle');
      setError(caught instanceof Error ? caught.message : 'Could not record the race');
    }
  };

  if (!open || typeof document === 'undefined') return null;

  // --- Shared section content — built once, placed differently by layout ----

  const racerPickerFields = (
    <>
      {/* Search + voice entry. */}
      <div className="shrink-0 space-y-2">
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            ref={searchRef}
            className="field !pl-10"
            placeholder={
              finishers.length >= 4
                ? 'Grid full — remove a car to swap one in'
                : 'Name, email or ride…'
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={phase !== 'idle'}
          />
        </div>

        {/*
          Rendered only on a definite yes from both gates — an unsupported
          browser or an unconfigured server shows nothing here at all rather
          than a button that would fail when pressed.
        */}
        {voiceReady === true && (voiceBusy || voicePhase === 'done') ? (
          /*
           * The button steps aside for the flow once there's something to
           * report. Three rows, but only the middle one is a real wait —
           * transcription and extraction happen inside a single request, so
           * there's no honest signal between them. "Grid ready" is therefore a
           * completion marker, not a phase pretending to take time: it ticks
           * when the response lands, alongside the row above it.
           */
          <div className="border border-hairline bg-white/[0.02] px-3.5 py-3">
            <FlowStep state="done" label="Recorded" />
            <FlowStep
              state={voiceBusy ? 'active' : 'done'}
              label={voiceBusy ? `${workingWord}…` : workingWord}
            />
            <FlowStep state={voiceBusy ? 'pending' : 'done'} label="Grid ready" last />
          </div>
        ) : voiceReady === true ? (
          <>
            {/*
              A raw <button> rather than NeonButton, because both live states
              need their own class on the element and NeonButton owns that slot
              for `ring`. `btn-primary` is written out literally here for the
              same reason it is inside NeonButton: a template-built class name
              never appears in Tailwind's scan and gets purged from the build.

              Padding is trimmed off `.btn-primary`'s full CTA size — this wants
              to be unmistakable, but "Add Score" is still the button that ends
              the flow, and two identically-sized primaries would argue.

              Only ever idle or recording here: once there's progress to report
              the flow above replaces this entirely.
            */}
            {/*
              `whitespace-nowrap` plus reduced tracking keeps every label on one
              line. `.btn-primary`'s 0.2em letter-spacing is generous for a
              two-word CTA and simply too wide for a sentence, so it's dialled
              back here rather than the labels being cut to fit.
            */}
            <button
              type="button"
              className={`btn btn-primary w-full whitespace-nowrap !py-3 !text-[0.7rem] !tracking-[0.1em] ${
                listening ? 'rec-live' : ''
              }`}
              // Never disabled while listening — that click is the stop button.
              disabled={phase !== 'idle'}
              onClick={() => (listening ? sessionRef.current?.stop() : void runVoiceEntry())}
            >
              {listening ? (
                <>
                  {/* A steady red dot: the recording convention, and the one cue
                      that survives `prefers-reduced-motion` killing the ring. */}
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#FF3B30]"
                    style={{ boxShadow: '0 0 10px #FF3B30' }}
                  />
                  Recording · tap to stop
                </>
              ) : (
                <>
                  <Mic size={14} />
                  Say it in Hebrew
                </>
              )}
            </button>

            {/*
              No live transcript any more: transcription happens server-side
              once recording stops, so there's nothing to show mid-sentence.
              What's heard surfaces on the grid rows instead, which is where it
              actually matters.
            */}
          </>
        ) : null}

        {/* Outside the branches: a failure or a caveat outlives the flow that
            produced it, and must not vanish when the button comes back. */}
        {voiceError && <p className="text-[0.65rem] text-danger">{voiceError}</p>}
        {voiceNote && <p className="text-[0.65rem] text-[#FFB020]">{voiceNote}</p>}
      </div>

      {/* Roster. */}
      <div
        className="no-scrollbar mt-3 flex-1 overflow-y-auto pr-1"
        style={{ scrollbarGutter: 'stable' }}
      >
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-[var(--text-faint)]">
            Nobody matches “{query}”.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {filtered.map((user) => {
              const selected = finishers.some((f) => f.racerId === user.id);
              const full = finishers.length >= 4;
              return (
                <button
                  key={user.id}
                  onClick={() => toggleRacer(user.id)}
                  disabled={phase !== 'idle' || (!selected && full)}
                  className={`group relative flex items-center gap-3 border p-2.5 text-left transition-all duration-200 disabled:opacity-40 ${
                    selected
                      ? 'border-transparent'
                      : 'border-hairline bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.05]'
                  }`}
                  style={
                    selected
                      ? {
                          ...withGlow(RACE_COLOR_HEX[user.raceColor]),
                          background: `linear-gradient(135deg, ${RACE_COLOR_HEX[user.raceColor]}2e, ${RACE_COLOR_HEX[user.raceColor]}0d)`,
                          boxShadow: `inset 0 0 0 1px ${RACE_COLOR_HEX[user.raceColor]}, 0 0 30px -12px ${RACE_COLOR_HEX[user.raceColor]}`,
                        }
                      : undefined
                  }
                >
                  <Avatar
                    {...(({ src, isRacerArt }) => ({ src, artwork: isRacerArt }))(avatarFor(user))}
                    name={user.displayName}
                    size={38}
                    accent={RACE_COLOR_HEX[user.raceColor]}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[0.75rem] font-bold uppercase tracking-wide text-white">
                      {user.displayName}
                    </span>
                    <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                      {user.favoriteRacer}
                    </span>
                    {/* This list is sorted by recency, but these are the numbers
                        that decide the board — worth seeing while picking. */}
                    <RacerStats stats={statsFromUser(user)} className="mt-0.5" />
                  </span>
                  {selected && (
                    <span
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
                      style={{
                        background: RACE_COLOR_HEX[user.raceColor],
                        boxShadow: `0 0 16px ${RACE_COLOR_HEX[user.raceColor]}`,
                      }}
                    >
                      <Check size={13} className="text-black" strokeWidth={3.5} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  const gridSection =
    finishers.length === 0 ? (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <Trophy className="mx-auto mb-3 opacity-25" size={38} />
          <p className="mx-auto max-w-xs text-sm text-[var(--text-faint)]">
            Pick the winner from the racers list to start logging the race.
          </p>
        </div>
      </div>
    ) : (
      <div>
        <Label className="mb-2">
          The grid · {finishers.length} {finishers.length === 1 ? 'car' : 'cars'}
          {finishers.length === 1 ? ' · winner only' : ' · drag to reorder'}
        </Label>
        <div ref={gridRef} className="space-y-2">
          {finishers.map((finisher, index) => {
            const user = usersById.get(finisher.racerId);
            if (!user) return null;
            const medal = PLACE_COLOR[Math.min(index, PLACE_COLOR.length - 1)];
            const rowIssue = scoreOrderIssues.get(finisher.racerId);
            return (
              <div
                key={finisher.racerId}
                className={`border bg-white/[0.015] p-3 transition ${
                  dragIndex === index
                    ? 'border-plasma/60 opacity-50'
                    : rowIssue
                      ? 'score-order-flicker border-danger/70'
                      : 'border-hairline'
                }`}
                style={withGlow(RACE_COLOR_HEX[user.raceColor])}
              >
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* Drag handle — works on touch and mouse via Pointer Events. */}
                  <span
                    onPointerDown={(event) => beginDrag(index, event)}
                    onPointerMove={dragOverMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    className="shrink-0 cursor-grab text-[var(--text-faint)] transition hover:text-plasma active:cursor-grabbing"
                    style={{ touchAction: 'none' }}
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical size={16} />
                  </span>

                  {/* Reorder arrows — the touch-friendly path. */}
                  <span className="flex shrink-0 flex-col">
                    <button
                      className="px-0.5 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                      disabled={index === 0 || phase !== 'idle'}
                      onClick={() => move(index, -1)}
                      aria-label="Move up"
                    >
                      <ChevronUp size={15} />
                    </button>
                    <button
                      className="px-0.5 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                      disabled={index === finishers.length - 1 || phase !== 'idle'}
                      onClick={() => move(index, 1)}
                      aria-label="Move down"
                    >
                      <ChevronDown size={15} />
                    </button>
                  </span>

                  {/* Place medal. */}
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center font-display text-sm font-black text-black"
                    style={{ background: medal, boxShadow: `0 0 14px ${medal}`, borderRadius: 4 }}
                    title={`Place ${index + 1}`}
                  >
                    {index + 1}
                  </span>

                  {/* Winner marker rides above the avatar as a ribbon
                      rather than trailing the name — inline it was the
                      first thing `truncate` ate on a narrow screen. */}
                  <span className="relative shrink-0">
                    <Avatar
                      src={user.avatarUrl}
                      name={user.displayName}
                      size={34}
                      accent={RACE_COLOR_HEX[user.raceColor]}
                    />
                    {index === 0 && (
                      <span
                        className="pointer-events-none absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap px-1 py-[0.1rem] font-display text-[0.45rem] font-black uppercase leading-none tracking-[0.1em] text-black"
                        style={{ background: medal, boxShadow: `0 0 10px ${medal}`, borderRadius: 2 }}
                      >
                        Winner
                      </span>
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[0.75rem] font-bold uppercase tracking-wide text-white">
                      {user.displayName}
                    </span>
                    {/*
                      What was actually said, when voice put this row here. This
                      is the whole safeguard for a wrong-but-valid match: seeing
                      "heard יוסי" above Dana Kessler is how anyone notices. It
                      replaces the ride name rather than crowding in beside it,
                      since it matters more while it's there.
                    */}
                    {heardBy[finisher.racerId] ? (
                      <span
                        dir="rtl"
                        className="block truncate text-right font-mono text-[0.6rem] text-plasma"
                        title="Heard this, matched to this racer — change it if that's wrong"
                      >
                        ⟵ {heardBy[finisher.racerId]}
                      </span>
                    ) : (
                      <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                        {user.favoriteRacer}
                      </span>
                    )}
                  </span>

                  {/* Score. */}
                  <label className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="label !text-[0.5rem]">Score</span>
                    <input
                      type="number"
                      min={0}
                      max={999}
                      inputMode="numeric"
                      className={`field !w-[4.5rem] !px-2 !py-1.5 text-right font-mono text-sm ${
                        rowIssue ? '!border-danger/70' : ''
                      }`}
                      placeholder={String(DEFAULT_SCORE_BY_PLACE[index] ?? 0)}
                      value={finisher.gameScore}
                      disabled={phase !== 'idle'}
                      onChange={(event) => setGameScore(finisher.racerId, event.target.value)}
                    />
                  </label>

                  <button
                    className="shrink-0 p-1.5 text-[var(--text-faint)] transition hover:text-danger disabled:opacity-30"
                    disabled={phase !== 'idle'}
                    onClick={() => toggleRacer(finisher.racerId)}
                    aria-label={`Remove ${user.displayName}`}
                  >
                    <X size={15} />
                  </button>
                </div>

                {/* Captured stats — one input per admin-defined metric. */}
                {captured.length > 0 && (
                  <div className="mt-2.5 grid grid-cols-2 gap-2 pl-9 sm:grid-cols-3 sm:pl-11 lg:grid-cols-4">
                    {captured.map((metric) => (
                      <label key={metric.id} className="flex flex-col gap-0.5">
                        <span className="label !text-[0.5rem] truncate">
                          {metric.label}
                          {metric.unit ? ` · ${metric.unit}` : ''}
                        </span>
                        <input
                          type="number"
                          min={0}
                          inputMode="numeric"
                          className="field !px-2 !py-1.5 font-mono text-xs"
                          placeholder="0"
                          value={finisher.stats[metric.id] ?? ''}
                          disabled={phase !== 'idle'}
                          onChange={(event) => setStat(finisher.racerId, metric.id, event.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );

  const extraSection = (
    <>
      {/* Kill log — who took out whom. Sets kills/deaths; revenge auto-tags. */}
      {finishers.length >= 2 && (
        <div>
          <Label>Kill log · optional{kills.length > 0 ? ` · ${kills.length}` : ''}</Label>
          <div className="mt-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <RacerSelect
                className="sm:flex-1"
                value={killer}
                onChange={setKiller}
                placeholder="Killer…"
                disabled={phase !== 'idle'}
                racers={finishers
                  .map((f) => usersById.get(f.racerId))
                  .filter((u): u is PublicUser => u !== undefined)}
              />
              <span className="shrink-0 text-center text-[0.62rem] uppercase tracking-widest text-[var(--text-faint)]">
                took out
              </span>
              <RacerSelect
                className="sm:flex-1"
                value={victim}
                onChange={setVictim}
                placeholder="Victim…"
                disabled={phase !== 'idle' || !killer}
                racers={finishers
                  .map((f) => usersById.get(f.racerId))
                  .filter((u): u is PublicUser => u !== undefined && u.id !== killer)}
              />
              <button
                className="btn btn-ghost shrink-0"
                disabled={phase !== 'idle' || !killer || !victim || killer === victim}
                onClick={addKill}
              >
                <Plus size={14} strokeWidth={3} /> Add kill
              </button>
            </div>

            {kills.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {kills.map((kill, index) => {
                  const killerUser = usersById.get(kill.killerId);
                  const victimUser = usersById.get(kill.victimId);
                  return (
                    <li
                      key={`${kill.killerId}-${kill.victimId}-${index}`}
                      className="flex items-center gap-2 border border-hairline bg-white/[0.015] px-3 py-1.5 text-xs"
                    >
                      <Skull size={13} className="shrink-0 text-[var(--text-faint)]" />
                      <span className="truncate font-display uppercase tracking-wide text-white">
                        {killerUser?.displayName ?? '—'}
                      </span>
                      <span className="text-[var(--text-faint)]">→</span>
                      <span className="truncate font-display uppercase tracking-wide text-white">
                        {victimUser?.displayName ?? '—'}
                      </span>
                      <button
                        className="ml-auto shrink-0 text-[var(--text-faint)] transition hover:text-danger disabled:opacity-30"
                        disabled={phase !== 'idle'}
                        onClick={() => removeKill(index)}
                        aria-label="Remove kill"
                      >
                        <X size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="mt-1.5 font-mono text-[0.6rem] text-[var(--text-faint)]">
              Each kill sets the racers' kills &amp; deaths. Revenge — a same-day
              payback — is tagged automatically.
            </p>
          </div>
        </div>
      )}

      {/* Optional note. */}
      <div>
        <Label className="mb-1.5">Note · optional</Label>
        <input
          className="field"
          placeholder="e.g. Volcano Loop, photo finish"
          maxLength={140}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={phase !== 'idle'}
        />
      </div>
    </>
  );

  const scoreIssueBanner = scoreOrderIssues.size > 0 && (
    <div className="space-y-1.5">
      {[...scoreOrderIssues.values()].map((message) => (
        <p key={message} className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {message}
        </p>
      ))}
    </div>
  );

  const errorBanner = error && (
    <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Record a race"
    >
      {/* Backdrop. */}
      <button
        className="absolute inset-0 bg-[#02030a]/85 backdrop-blur-md"
        style={{
          animation: closing
            ? 'overlay-backdrop-out 200ms ease forwards'
            : 'overlay-backdrop-in 240ms ease both',
        }}
        onClick={requestClose}
        aria-label="Close"
      />

      {/* Full-screen panel: header · body · footer. */}
      <Panel
        accent={accent}
        lit
        className="relative flex h-full w-full flex-col overflow-hidden"
        style={{
          transformOrigin: 'center',
          animation: closing
            ? 'overlay-collapse 200ms cubic-bezier(0.4,0,1,1) forwards'
            : 'overlay-expand 300ms cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {/* Header. */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-5 py-4 sm:px-8 sm:py-5">
          <div className="min-w-0">
            <Label>Log the race</Label>
            {/* Step dots — mobile only, a glance at where you are in the wizard. */}
            {!isDesktop && (
              <div className="mt-2.5 flex items-center gap-1.5" aria-hidden="true">
                {STEPS.map((candidate) => (
                  <span
                    key={candidate}
                    className="h-1.5 w-5 rounded-full transition-colors"
                    style={{
                      background: candidate === step ? accent : 'rgb(255 255 255 / 0.12)',
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            className="btn btn-ghost shrink-0 !px-2.5 !py-2"
            onClick={requestClose}
            disabled={phase !== 'idle'}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body. */}
        {isDesktop ? (
          <div className="flex min-h-0 flex-1 flex-row">
            {/* LEFT · racer picker. */}
            <div className="flex min-h-0 flex-1 flex-col border-r border-hairline px-6 py-6 lg:w-[380px] lg:flex-none xl:w-[420px]">
              <Label className="mb-2">Add racers</Label>
              {racerPickerFields}
            </div>

            {/* RIGHT · the race. */}
            <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 py-6">
              {/* Above the grid, not below it and the kill log: a problem you
                  have to scroll to find is a problem you find at submit time. */}
              {scoreIssueBanner}
              {gridSection}
              {finishers.length > 0 && extraSection}
              {errorBanner}
            </div>
          </div>
        ) : (
          <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            {step === 'racers' && (
              <div className="flex min-h-0 flex-1 flex-col">
                <Label className="mb-2">Racers · {finishers.length} selected</Label>
                {racerPickerFields}
              </div>
            )}
            {step === 'grid' && gridSection}
            {step === 'extra' && (
              <>
                {extraSection}
                {errorBanner}
              </>
            )}
          </div>
        )}

        {/*
          Mobile: pinned above the footer rather than living inside the grid
          step. Voice fills the grid while you're still on the racers step, so a
          banner scoped to that step would compute the problem and then hide it
          until you tapped Proceed — which is exactly when it's too late to be
          useful. Outside the step switch, it's unmissable wherever you are.
        */}
        {!isDesktop && scoreIssueBanner && (
          <div className="shrink-0 border-t border-hairline px-5 pt-3">{scoreIssueBanner}</div>
        )}

        {/* Footer — actions pinned to the bottom. */}
        {isDesktop ? (
          <div className="flex shrink-0 flex-col-reverse items-stretch gap-3 border-t border-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <button className="btn btn-ghost" onClick={requestClose} disabled={phase !== 'idle'}>
              Cancel
            </button>
            <SubmitButton
              accent={accent}
              phase={phase}
              armed={canSubmit}
              winnerName={winner?.displayName}
              onClick={() => void submit()}
            />
          </div>
        ) : (
          <div className="sticky bottom-0 flex shrink-0 items-center gap-3 border-t border-hairline px-5 py-4">
            <button
              className="btn btn-ghost !px-4"
              disabled={phase !== 'idle'}
              onClick={() => {
                if (step === 'racers') requestClose();
                else setStep(step === 'extra' ? 'grid' : 'racers');
              }}
            >
              {step === 'racers' ? 'Cancel' : 'Back'}
            </button>

            {step === 'racers' && (
              <NeonButton
                variant="primary"
                accent={accent}
                className="flex-1"
                disabled={!canProceedPastRacers}
                onClick={() => setStep('grid')}
              >
                Proceed
              </NeonButton>
            )}
            {step === 'grid' && (
              <NeonButton
                variant="primary"
                accent={accent}
                className="flex-1"
                disabled={!canProceedPastGrid}
                onClick={() => setStep('extra')}
              >
                Proceed
              </NeonButton>
            )}
            {step === 'extra' && (
              <SubmitButton
                accent={accent}
                phase={phase}
                armed={canSubmit}
                winnerName={winner?.displayName}
                winnerAvatarUrl={winner?.avatarUrl}
                variant="mobile"
                className="flex-1"
                onClick={() => void submit()}
              />
            )}
          </div>
        )}
      </Panel>
    </div>,
    document.body,
  );
}

/**
 * The fancy bit. Three visual states:
 *  - disarmed: flat, waiting for a valid grid
 *  - armed:    rotating conic ring, drifting gradient, hover sparks
 *  - charging: fills left-to-right, shockwave, then flashes white on launch
 *
 * `variant="mobile"` swaps the idle-armed content for the winner's photo +
 * "Add Score" + a crown, since on the wizard's last step the racer being
 * scored is already the entire context — naming them again ("Crown Alex")
 * is redundant when their face is right there in the grid one step back.
 * Every other state (disarmed/charging/launched) stays the same on both.
 */
function SubmitButton({
  accent,
  phase,
  armed,
  winnerName,
  winnerAvatarUrl,
  variant = 'desktop',
  className = '',
  onClick,
}: {
  accent: string;
  phase: 'idle' | 'charging' | 'launched';
  armed: boolean;
  winnerName?: string;
  winnerAvatarUrl?: string;
  variant?: 'desktop' | 'mobile';
  className?: string;
  onClick: () => void;
}) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: i,
        left: 8 + i * 9,
        dx: Math.round(Math.sin(i * 1.9) * 34),
        dy: -22 - (i % 4) * 12,
        delay: (i % 5) * 0.11,
      })),
    [],
  );

  const busy = phase !== 'idle';
  const armedIdle = armed && !busy;
  const label =
    phase === 'launched'
      ? 'Launched'
      : phase === 'charging'
        ? 'Recording…'
        : armed
          ? variant === 'mobile'
            ? 'Add Score'
            : `Crown ${winnerName?.split(' ')[0] ?? 'them'}`
          : 'Pick a winner';

  return (
    <button
      onClick={onClick}
      disabled={!armed || busy}
      className={`btn relative isolate min-w-[13rem] overflow-visible !py-3.5 !text-[0.72rem] sm:!text-xs ${
        armed ? 'ring-spin text-white' : 'text-[var(--text-faint)]'
      } ${className}`}
      style={{
        ...withGlow(accent),
        /*
         * Longhands only, never the `background` shorthand — and this is a real
         * bug rather than a lint nicety. The shorthand resets background-size to
         * `auto`, so each time `armed` flipped React rewrote `background` and
         * wiped the 220% width that `submit-drift` slides across, leaving the
         * animation running with nothing to move. React's warning about mixing
         * the two is pointing at exactly that.
         */
        backgroundImage: armed
          ? `linear-gradient(115deg, ${accent}, #FF2D95 55%, ${accent} 110%)`
          : 'none',
        backgroundColor: armed ? 'transparent' : 'rgb(255 255 255 / 0.03)',
        backgroundSize: '220% 100%',
        border: armed ? 'none' : '1px solid var(--hairline)',
        boxShadow: armed
          ? `0 0 0 1px rgb(255 255 255 / 0.2), 0 12px 40px -14px ${accent}`
          : 'none',
        animation: armed && !busy ? 'submit-drift 3.4s ease-in-out infinite' : undefined,
        cursor: armed && !busy ? 'pointer' : undefined,
      }}
    >
      {/* Charge fill. */}
      {phase === 'charging' && (
        <span
          className="absolute inset-0 -z-10 origin-left"
          style={{
            background: 'linear-gradient(90deg, #fff, rgb(255 255 255 / 0.2))',
            animation: 'charge-fill 620ms linear forwards',
            mixBlendMode: 'overlay',
          }}
        />
      )}

      {/* Launch flash + shockwave. */}
      {phase === 'launched' && (
        <>
          <span
            className="absolute inset-0 -z-10 bg-white"
            style={{ animation: 'flash-out 420ms ease-out forwards' }}
          />
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: '#fff', animation: 'shockwave 620ms ease-out forwards' }}
          />
        </>
      )}

      {/* Hover sparks, armed state only. */}
      {armedIdle && (
        <span className="pointer-events-none absolute inset-0 overflow-visible opacity-0 transition-opacity duration-300 hover:opacity-100 group-hover:opacity-100 [button:hover>&]:opacity-100">
          {sparks.map((spark) => (
            <span
              key={spark.id}
              className="absolute bottom-1 h-1 w-1 rounded-full bg-white"
              style={{
                left: `${spark.left}%`,
                boxShadow: '0 0 8px #fff',
                ['--dx' as string]: `${spark.dx}px`,
                ['--dy' as string]: `${spark.dy}px`,
                animation: `spark-fly 900ms ${spark.delay}s ease-out infinite`,
              }}
            />
          ))}
        </span>
      )}

      {variant === 'mobile' && armedIdle ? (
        <span className="relative inline-flex shrink-0">
          <Avatar src={winnerAvatarUrl} name={winnerName ?? ''} size={30} accent="#fff" />
          <span
            className="absolute -right-1 -top-1 z-20 grid h-[16px] w-[16px] place-items-center rounded-full"
            style={{ background: '#0d1122', boxShadow: '0 0 0 1.5px rgb(255 255 255 / 0.55), 0 0 8px rgba(0,0,0,0.6)' }}
          >
            <Crown size={10} className="text-[#FFD23F]" />
          </span>
        </span>
      ) : (
        <Trophy size={15} className={phase === 'charging' ? 'animate-spin' : armed ? 'animate-hover' : ''} />
      )}
      <span className="relative">{label}</span>

      <style>{`
        @keyframes submit-drift {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @keyframes charge-fill {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
        @keyframes flash-out {
          from { opacity: 0.95; }
          to   { opacity: 0; }
        }
      `}</style>
    </button>
  );
}

/**
 * A themed racer picker — avatar + name, not a bare native <select>. Opens a
 * neon option list, closes on outside-click or Escape. Only a handful of
 * options (the race's finishers), so a simple absolute panel is plenty.
 */
function RacerSelect({
  value,
  onChange,
  racers,
  placeholder,
  disabled,
  className = '',
}: {
  value: string;
  onChange: (id: string) => void;
  racers: PublicUser[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A disabled control must never hang open (e.g. victim before a killer is set).
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selected = racers.find((r) => r.id === value) ?? null;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="field flex w-full items-center gap-2 !py-2 text-left disabled:opacity-50"
      >
        {selected ? (
          <>
            <Avatar src={selected.avatarUrl} name={selected.displayName} size={22} accent={RACE_COLOR_HEX[selected.raceColor]} />
            <span className="min-w-0 flex-1 truncate font-display text-[0.72rem] font-bold uppercase tracking-wide text-white">
              {selected.displayName}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[var(--text-faint)]">{placeholder}</span>
        )}
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--text-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto border border-hairline bg-[#0a0e1c] shadow-[0_18px_50px_-12px_rgba(0,0,0,0.85)]"
        >
          {racers.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--text-faint)]">No racers to pick</p>
          ) : (
            racers.map((racer) => {
              const active = racer.id === value;
              return (
                <button
                  key={racer.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(racer.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/[0.06] ${
                    active ? 'bg-white/[0.05]' : ''
                  }`}
                >
                  <Avatar src={racer.avatarUrl} name={racer.displayName} size={22} accent={RACE_COLOR_HEX[racer.raceColor]} />
                  <span className="min-w-0 flex-1 truncate font-display text-[0.72rem] font-bold uppercase tracking-wide text-white">
                    {racer.displayName}
                  </span>
                  {active && (
                    <Check size={13} className="shrink-0" style={{ color: RACE_COLOR_HEX[racer.raceColor] }} strokeWidth={3} />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default AddScoreOverlay;
