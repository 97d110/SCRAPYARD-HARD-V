import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import { UsersService } from '../users/users.service';
import type { PeriodKind, Scoreboard, UserRecord, WinEntry } from '@scrapyard/shared';
import { dayKey, monthKey } from '../common/period.util';

export interface AwardResult {
  win: WinEntry;
  winner: UserRecord;
  allTime: number;
  boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
}

@Injectable()
export class ScoresService {
  private readonly logger = new Logger(ScoresService.name);

  constructor(
    private readonly mongo: MongoService,
    private readonly scoreboards: ScoreboardRepository,
    private readonly users: UsersService,
  ) {}

  /**
   * Record a win. One award = one point.
   *
   * ── This used to be the most complicated function in the codebase ─────────
   *
   * Under the file store it was a five-file cascade inside a global mutex:
   * bump the user file, then recompute the all-time, monthly and daily boards
   * from every user file, then regenerate an index. All of that existed to keep
   * derived copies consistent with the source of truth.
   *
   * Here it is one `insertOne`. A win is an immutable event, so there is no
   * read-modify-write, nothing to lock, and no derived copy to keep in step —
   * boards are aggregations computed on read. Two simultaneous awards cannot
   * interfere with each other, and the app can run on any number of instances.
   */
  async awardWin(winnerId: string, awardedBy: string, note?: string): Promise<AwardResult> {
    const at = new Date();
    const day = dayKey(at);
    const month = monthKey(at);

    // Fails with 404 if the racer doesn't exist, before we write anything.
    const winner = await this.users.requireRaw(winnerId);

    const win: WinEntry = {
      id: randomUUID(),
      userId: winner.id,
      at: at.toISOString(),
      monthKey: month,
      dayKey: day,
      awardedBy,
      ...(note?.trim() ? { note: note.trim().slice(0, 140) } : {}),
    };

    const wins = await this.mongo.wins();
    await wins.insertOne({
      _id: win.id,
      userId: win.userId,
      at,
      monthKey: month,
      dayKey: day,
      awardedBy,
      ...(win.note ? { note: win.note } : {}),
    });

    const boards = await this.scoreboards.currentBoards();
    const allTime =
      boards.allTime.entries.find((entry) => entry.userId === winner.id)?.points ?? 0;

    this.logger.log(`+1 → ${winner.displayName} (${allTime} all-time)`);

    return { win, winner, allTime, boards };
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

  /** Every period with at least one win, newest first — for the archive picker. */
  async listPeriods(): Promise<Array<{ kind: PeriodKind; key: string }>> {
    const { months, days } = await this.scoreboards.knownPeriods();
    return [
      { kind: 'all-time' as const, key: 'all-time' },
      ...months.map((key) => ({ kind: 'monthly' as const, key })),
      ...days.map((key) => ({ kind: 'daily' as const, key })),
    ];
  }
}
