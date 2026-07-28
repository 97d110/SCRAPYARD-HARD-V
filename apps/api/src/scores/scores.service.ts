import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService, GameResultDoc, KillEventDoc } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import { UsersService } from '../users/users.service';
import { MetricsService } from '../metrics/metrics.service';
import type {
  GameEntry,
  GameResultInput,
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

    return input
      .map((r) => {
        const gameScore = this.clampInt(r.gameScore ?? 0, 0, MAX_SCORE, 'in-game score');
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
}
