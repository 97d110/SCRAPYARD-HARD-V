/**
 * The kill log and the same-day revenge rule.
 *
 * A race carries a list of directed kills (killer → victim). From that we
 * derive each racer's `kills` and `deaths`, so those never have to be typed.
 *
 * ── Revenge: a same-day grudge ledger ───────────────────────────────────────
 *
 * A kill is *revenge* when the killer was themselves killed by this victim
 * earlier the same day and that death hasn't been paid back yet. We keep a
 * ledger of unavenged kills per (victim, killer) pair; a revenge kill settles
 * exactly one grudge, so a single death can't spawn endless revenges. The
 * ledger is scoped to one day — yesterday's grievances don't carry over.
 *
 * Both the live record path and the seeder run kills through the *same*
 * algorithm, so seeded history and freshly recorded races tag revenge
 * identically.
 */

export interface KillPair {
  killerId: string;
  victimId: string;
}

export interface KillEvent extends KillPair {
  revenge: boolean;
}

/** A running same-day ledger of who owes whom. Reused across a day's games. */
export class GrudgeLedger {
  /** unavenged[victim][killer] = kills `killer` landed on `victim`, not yet repaid. */
  private readonly unavenged = new Map<string, Map<string, number>>();

  private outstanding(victim: string, killer: string): number {
    return this.unavenged.get(victim)?.get(killer) ?? 0;
  }

  private adjust(victim: string, killer: string, delta: number): void {
    const row = this.unavenged.get(victim) ?? new Map<string, number>();
    row.set(killer, (row.get(killer) ?? 0) + delta);
    this.unavenged.set(victim, row);
  }

  /**
   * Apply one kill and report whether it was revenge. `killer` taking out
   * `victim` is revenge if `victim` had an unpaid kill on `killer`; that grudge
   * is then cleared, and the killer's fresh kill becomes a new grudge the
   * victim may later settle.
   */
  apply(pair: KillPair): boolean {
    const revenge = this.outstanding(pair.killerId, pair.victimId) > 0;
    if (revenge) this.adjust(pair.killerId, pair.victimId, -1);
    this.adjust(pair.victimId, pair.killerId, 1);
    return revenge;
  }
}

/**
 * Tag one game's kills with revenge, given the day's earlier kills in order.
 * `prior` seeds the ledger (their revenge status doesn't matter, only their
 * effect on outstanding grudges); `incoming` is this game's kills in order.
 */
export function tagRevengeSameDay(prior: KillPair[], incoming: KillPair[]): KillEvent[] {
  const ledger = new GrudgeLedger();
  for (const pair of prior) ledger.apply(pair);
  return incoming.map((pair) => ({ ...pair, revenge: ledger.apply(pair) }));
}

/** Per-racer kills (as killer) and deaths (as victim) from a kill log. */
export function killDerivedStats(events: KillPair[]): Map<string, { kills: number; deaths: number }> {
  const out = new Map<string, { kills: number; deaths: number }>();
  const bump = (id: string, key: 'kills' | 'deaths') => {
    const row = out.get(id) ?? { kills: 0, deaths: 0 };
    row[key] += 1;
    out.set(id, row);
  };
  for (const event of events) {
    bump(event.killerId, 'kills');
    bump(event.victimId, 'deaths');
  }
  return out;
}
