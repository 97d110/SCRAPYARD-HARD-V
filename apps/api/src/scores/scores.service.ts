import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService, GameDoc, GameResultDoc, KillEventDoc } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';
import type {
  DeleteGameResponse,
  GameEntry,
  GameResultInput,
  GamesPage,
  KillEventInput,
  PeriodKind,
  Scoreboard,
  UserRecord,
} from '@scrapyard/shared';
import { dayKey, monthKey } from '../common/period.util';
import { killDerivedStats, tagRevengeSameDay, type KillPair } from '../common/kills';

const MAX_KILLS = 60;

export interface RecordGameResult {
  game: GameEntry;
  /** The first-place finisher. */
  winner: UserRecord;
  /** The winner's all-time win count after this race. */
  allTime: number;
  boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
}

const MAX_FIELD = 4;
const MAX_SCORE = 999;
const MAX_STAT = 99_999;

/**
 * The scoring ground rules, enforced server-side so no client can skip them:
 *
 *  - A blank/zero score falls back to the standard purse for that place.
 *  - The winner's purse never drops below `WINNER_MIN_SCORE` — silently
 *    topped up rather than rejected, whether it was left blank or typed low.
 *  - Beyond that, scores must not increase further down the finishing
 *    order (ties are fine) — that one *is* rejected, since silently
 *    reshuffling someone's typed number would be guessing at their intent.
 */
const DEFAULT_SCORE_BY_PLACE: Record<number, number> = { 1: 15, 2: 10, 3: 5, 4: 0 };
const WINNER_MIN_SCORE = 15;

@Injectable()
export class ScoresService {
  private readonly logger = new Logger(ScoresService.name);

  constructor(
    private readonly mongo: MongoService,
    private readonly scoreboards: ScoreboardRepository,
    private readonly users: UsersService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Record a race. One race = one immutable `games` document.
   *
   * Like the old single-winner award, this is a single `insertOne`: an atomic
   * write with no lock and no cascade. The document carries 2–4 finishers with
   * their place, in-game score and captured stats; every board and achievement
   * is aggregated fresh from it on read.
   */
  async recordGame(input: {
    results: GameResultInput[];
    events?: KillEventInput[];
    awardedBy: string;
    note?: string;
  }): Promise<RecordGameResult> {
    const results = await this.validate(input.results);
    const racerIds = new Set(results.map((r) => r.racerId));
    const rawEvents = this.validateEvents(input.events ?? [], racerIds);

    const at = new Date();
    const day = dayKey(at);
    const month = monthKey(at);
    const id = randomUUID();
    const note = input.note?.trim() ? input.note.trim().slice(0, 140) : undefined;

    const games = await this.mongo.games();

    // Revenge is scoped to the day, so seed the ledger from today's earlier
    // kills (in chronological order) before tagging this game's log.
    const priorGames = await games
      .find({ dayKey: day }, { projection: { events: 1, at: 1 } })
      .sort({ at: 1 })
      .toArray();
    const prior: KillPair[] = priorGames.flatMap((g) =>
      (g.events ?? []).map((e) => ({ killerId: e.killerId, victimId: e.victimId })),
    );
    const events: KillEventDoc[] = tagRevengeSameDay(prior, rawEvents);

    // kills/deaths are derived from the log, never trusted from the client.
    const derived = killDerivedStats(rawEvents);
    for (const result of results) {
      const d = derived.get(result.racerId) ?? { kills: 0, deaths: 0 };
      result.stats.kills = d.kills;
      result.stats.deaths = d.deaths;
    }

    await games.insertOne({
      _id: id,
      at,
      monthKey: month,
      dayKey: day,
      awardedBy: input.awardedBy,
      ...(note ? { note } : {}),
      results,
      events,
    });

    const winnerId = results.find((r) => r.place === 1)!.racerId;
    const winner = await this.users.requireRaw(winnerId);

    const boards = await this.scoreboards.currentBoards();
    const allTime =
      boards.allTime.entries.find((entry) => entry.userId === winnerId)?.metrics.wins ?? 0;

    const game: GameEntry = {
      id,
      at: at.toISOString(),
      monthKey: month,
      dayKey: day,
      awardedBy: input.awardedBy,
      ...(note ? { note } : {}),
      results,
      events,
    };

    const revenges = events.filter((e) => e.revenge).length;
    this.logger.log(
      `Race recorded: ${results.length} finishers, ${events.length} kills` +
        `${revenges ? ` (${revenges} revenge)` : ''}, winner ${winner.displayName} (${allTime} all-time wins)`,
    );

    return { game, winner, allTime, boards };
  }

  /**
   * Validate and normalise a race's finishers: 2–4 distinct racers that all
   * exist, places forming a clean 1…N ranking, sane scores, and captured stats
   * restricted to known metrics.
   */
  private async validate(input: GameResultInput[]): Promise<GameResultDoc[]> {
    // A winner alone is enough — everything past first place is optional.
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FIELD) {
      throw new BadRequestException(`A race needs 1–${MAX_FIELD} finishers`);
    }

    const racerIds = input.map((r) => r.racerId);
    if (new Set(racerIds).size !== racerIds.length) {
      throw new BadRequestException('A racer can only appear once in a race');
    }

    const places = input.map((r) => r.place).sort((a, b) => a - b);
    const expected = input.map((_, i) => i + 1);
    if (places.some((p, i) => p !== expected[i])) {
      throw new BadRequestException(`Places must be 1…${input.length} with no gaps or ties`);
    }

    // Every racer must exist. requireRaw throws 404 before anything is written.
    await Promise.all(input.map((r) => this.users.requireRaw(r.racerId)));

    const capturedIds = new Set((await this.metrics.registry()).captured.map((m) => m.id));

    const results = input
      .map((r) => {
        let gameScore = this.clampInt(r.gameScore ?? 0, 0, MAX_SCORE, 'in-game score');
        if (gameScore === 0) gameScore = DEFAULT_SCORE_BY_PLACE[r.place] ?? 0;
        if (r.place === 1 && gameScore < WINNER_MIN_SCORE) gameScore = WINNER_MIN_SCORE;

        const stats: Record<string, number> = {};
        for (const [key, raw] of Object.entries(r.stats ?? {})) {
          // Silently drop unknown metrics so an evolving metric list never
          // rejects a race the client built against an older registry.
          if (!capturedIds.has(key)) continue;
          stats[key] = this.clampInt(raw, 0, MAX_STAT, `stat '${key}'`);
        }
        return { racerId: r.racerId, place: r.place, gameScore, stats };
      })
      .sort((a, b) => a.place - b.place);

    // Scores must not climb back up further down the running order.
    for (let i = 1; i < results.length; i += 1) {
      if (results[i].gameScore > results[i - 1].gameScore) {
        throw new BadRequestException(
          `Place ${results[i].place}'s score can't beat place ${results[i - 1].place}'s`,
        );
      }
    }

    return results;
  }

  /**
   * Validate the kill log: every killer and victim must be a racer in this
   * race, and nobody kills themselves. Revenge is resolved later, against the
   * day's ledger — not something the client gets to assert.
   */
  private validateEvents(input: KillEventInput[], racerIds: Set<string>): KillPair[] {
    if (!Array.isArray(input)) return [];
    if (input.length > MAX_KILLS) {
      throw new BadRequestException(`A race can log at most ${MAX_KILLS} kills`);
    }
    return input.map((event) => {
      const killerId = String(event.killerId ?? '');
      const victimId = String(event.victimId ?? '');
      if (!racerIds.has(killerId) || !racerIds.has(victimId)) {
        throw new BadRequestException('Every kill must be between racers in this race');
      }
      if (killerId === victimId) {
        throw new BadRequestException('A racer cannot kill themselves');
      }
      return { killerId, victimId };
    });
  }

  private clampInt(value: unknown, min: number, max: number, label: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new BadRequestException(`${label} must be a number`);
    const rounded = Math.round(n);
    if (rounded < min || rounded > max) {
      throw new BadRequestException(`${label} must be between ${min} and ${max}`);
    }
    return rounded;
  }

  async readBoard(kind: PeriodKind, key: string): Promise<Scoreboard> {
    return this.scoreboards.board(kind, key);
  }

  async readCurrentBoards(): Promise<{
    allTime: Scoreboard;
    monthly: Scoreboard;
    daily: Scoreboard;
  }> {
    return this.scoreboards.currentBoards();
  }

  /** Every period with at least one game, newest first — for the archive picker. */
  async listPeriods(): Promise<Array<{ kind: PeriodKind; key: string }>> {
    const { months, days } = await this.scoreboards.knownPeriods();
    return [
      { kind: 'all-time' as const, key: 'all-time' },
      ...months.map((key) => ({ kind: 'monthly' as const, key })),
      ...days.map((key) => ({ kind: 'daily' as const, key })),
    ];
  }

  /**
   * Admin race log: newest-first, optionally scoped to one day, with a
   * cursor (`before`, an ISO timestamp) rather than an offset — stable while
   * new games keep landing on page 1.
   */
  async listGames(params: { limit?: number; before?: string; day?: string }): Promise<GamesPage> {
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 100);
    const games = await this.mongo.games();

    const filter: Record<string, unknown> = {};
    if (params.day) filter.dayKey = params.day;
    if (params.before) {
      const before = new Date(params.before);
      if (!Number.isNaN(before.getTime())) filter.at = { $lt: before };
    }

    // Fetch one extra to know whether there's a next page without a second round trip.
    const docs = await games
      .find(filter)
      .sort({ at: -1 })
      .limit(limit + 1)
      .toArray();

    const page = docs.slice(0, limit);
    const nextBefore = docs.length > limit ? page[page.length - 1].at.toISOString() : undefined;

    return { games: page.map((doc) => this.toEntry(doc)), ...(nextBefore ? { nextBefore } : {}) };
  }

  /**
   * Delete a game and, if needed, cascade.
   *
   * Boards and achievements need nothing — they're aggregated fresh from
   * `games` on every read, so the deletion is already reflected on the next
   * load. The one exception is the kill log's `revenge` flag: it's resolved
   * once, at write time, against that day's grudge ledger seeded from
   * *earlier* games. Removing a game can strand a later game's `revenge: true`
   * pointing at a kill that, from the ledger's perspective, never happened.
   *
   * The fix is to replay the whole remaining day from an empty ledger and
   * write back only the games whose flags actually changed. Replaying the
   * whole day (not just the games after the deleted one) is deliberately the
   * simplest correct option: games before the deletion point get an identical
   * ledger state back, so they're no-ops, and there's no separate "only
   * after X" bookkeeping to get wrong.
   */
  async deleteGame(id: string): Promise<DeleteGameResponse> {
    const games = await this.mongo.games();
    const game = await games.findOne({ _id: id });
    if (!game) throw new NotFoundException('No such game');

    await games.deleteOne({ _id: id });

    const remaining = await games
      .find({ dayKey: game.dayKey })
      .sort({ at: 1 })
      .toArray();

    const pairs = remaining.flatMap((g) =>
      g.events.map((e) => ({ killerId: e.killerId, victimId: e.victimId })),
    );
    const retagged = tagRevengeSameDay([], pairs);

    let cursor = 0;
    let recomputedGames = 0;
    for (const g of remaining) {
      const slice = retagged.slice(cursor, cursor + g.events.length);
      cursor += g.events.length;

      const changed = slice.some((event, i) => event.revenge !== g.events[i]?.revenge);
      if (changed) {
        await games.updateOne({ _id: g._id }, { $set: { events: slice } });
        recomputedGames += 1;
      }
    }

    this.logger.log(
      `Game ${id} deleted (${game.dayKey}, ${game.results.length} finishers)` +
        `${recomputedGames ? ` — ${recomputedGames} later game(s) that day recomputed for revenge` : ''}`,
    );

    return { deletedId: id, dayKey: game.dayKey, recomputedGames };
  }

  private toEntry(doc: GameDoc): GameEntry {
    return {
      id: doc._id,
      at: doc.at.toISOString(),
      monthKey: doc.monthKey,
      dayKey: doc.dayKey,
      awardedBy: doc.awardedBy,
      ...(doc.note ? { note: doc.note } : {}),
      results: doc.results,
      events: doc.events,
    };
  }
}
