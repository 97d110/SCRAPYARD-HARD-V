import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JsonStoreService } from '../database/json-store.service';
import { IndexService } from '../database/index.service';
import { ScoreboardBuilder } from '../database/scoreboard.builder';
import { UsersService } from '../users/users.service';
import type { PeriodKind, ScoreboardFile, UserRecord, WinEntry } from '@scrapyard/shared';
import { dayKey, monthKey } from '../common/period.util';

export interface AwardResult {
  win: WinEntry;
  winner: UserRecord;
  boards: [ScoreboardFile, ScoreboardFile, ScoreboardFile];
}

@Injectable()
export class ScoresService {
  private readonly logger = new Logger(ScoresService.name);

  constructor(
    private readonly store: JsonStoreService,
    private readonly index: IndexService,
    private readonly builder: ScoreboardBuilder,
    private readonly users: UsersService,
  ) {}

  /**
   * Record a win. One award = one point.
   *
   * The write cascade, all inside a single transaction so it can't interleave
   * with another award:
   *   1. bump the winner's own file (all-time, this month, today)
   *   2. regenerate scores/all-time.json
   *   3. regenerate scores/monthly-<YYYY-MM>.json
   *   4. regenerate scores/daily-<YYYY-MM-DD>.json
   *   5. regenerate index/index.json
   *
   * Steps 2–4 recompute from the user files rather than incrementing, so the
   * derived boards can never drift out of sync with the source of truth.
   */
  async awardWin(winnerId: string, awardedBy: string, note?: string): Promise<AwardResult> {
    return this.store.transaction(async () => {
      const at = new Date();
      const day = dayKey(at);
      const month = monthKey(at);

      const winner = await this.users.requireRaw(winnerId);

      const win: WinEntry = {
        id: randomUUID(),
        at: at.toISOString(),
        monthKey: month,
        dayKey: day,
        awardedBy,
        ...(note?.trim() ? { note: note.trim().slice(0, 140) } : {}),
      };

      const updated: UserRecord = {
        ...winner,
        updatedAt: at.toISOString(),
        scores: {
          allTime: winner.scores.allTime + 1,
          monthly: {
            ...winner.scores.monthly,
            [month]: (winner.scores.monthly[month] ?? 0) + 1,
          },
          daily: { ...winner.scores.daily, [day]: (winner.scores.daily[day] ?? 0) + 1 },
        },
        // Newest first, capped so a single file never grows unbounded.
        wins: [win, ...winner.wins].slice(0, 1000),
      };

      await this.store.write(`users/${updated.id}.json`, updated);

      const boards = await this.builder.writeForWin(month, day);
      await this.index.rebuild();

      this.logger.log(`+1 → ${updated.displayName} (${updated.scores.allTime} all-time)`);
      return { win, winner: updated, boards };
    });
  }

  /** Force a full recomputation of every derived board. */
  async rebuildAll(): Promise<ScoreboardFile[]> {
    return this.store.transaction(() => this.builder.rebuildAll());
  }

  async readBoard(kind: PeriodKind, key: string): Promise<ScoreboardFile> {
    return this.builder.read(kind, key);
  }

  /** The three boards the main page opens with. */
  async readCurrentBoards(): Promise<Record<'allTime' | 'monthly' | 'daily', ScoreboardFile>> {
    return {
      allTime: await this.builder.read('all-time', 'all-time'),
      monthly: await this.builder.read('monthly', monthKey()),
      daily: await this.builder.read('daily', dayKey()),
    };
  }

  async listBoards(): Promise<ScoreboardFile[]> {
    return this.builder.list();
  }
}
