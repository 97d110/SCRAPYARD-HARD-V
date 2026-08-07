/**
 * The scoring ground rules, mirrored client-side.
 *
 * ── Why these exist twice ───────────────────────────────────────────────────
 *
 * The server is the authority: `ScoresService` applies all of this again on
 * every write, and a client that skipped it would simply be corrected. These
 * copies exist so the entry form and the admin race editor can validate and
 * preview live, without a round trip per keystroke.
 *
 * ── Why they live here rather than in each screen ───────────────────────────
 *
 * They started as module constants inside AddScoreOverlay. The admin race
 * editor needs exactly the same numbers to show what a correction will save,
 * and a second copy of a magic number is how the two quietly stop agreeing —
 * at which point one screen previews a 15 and the other a 10 for the same
 * input. One copy per side of the wire is the most that should ever exist.
 *
 * They cannot come from @scrapyard/shared: that package is types only, with no
 * runtime values (see its header). If the server's numbers change, change these
 * — the pair in apps/api/src/scores/scores.service.ts is the original.
 */

/** Standard purse by place, indexed by `place - 1`. */
export const DEFAULT_SCORE_BY_PLACE = [15, 10, 5, 0];

/** A win is worth at least this much, however it was typed. */
export const WINNER_MIN_SCORE = 15;

/**
 * What a finisher's score actually resolves to when saved: blank or zero falls
 * back to the standard purse for that place, and the winner's purse is topped
 * up to the floor.
 *
 * Note this is what will be *stored*, which is not always the right thing to
 * validate against — the winner floor rewrites a suspiciously low first place
 * into a plausible one, hiding the very mistake worth catching. See
 * `enteredScores` in AddScoreOverlay for where that distinction bites.
 */
export function effectiveScore(raw: string, place: number): number {
  const typed = raw.trim() === '' ? 0 : Math.max(0, Number(raw) || 0);
  let score = typed === 0 ? (DEFAULT_SCORE_BY_PLACE[place - 1] ?? 0) : typed;
  if (place === 1 && score < WINNER_MIN_SCORE) score = WINNER_MIN_SCORE;
  return score;
}
