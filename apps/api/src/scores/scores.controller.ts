import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ScoresService } from './scores.service';
import type { PublicUser, ScoreboardFile } from '@scrapyard/shared';
import { dayKey, monthKey, periodKindOf } from '../common/period.util';
import { BadRequestException } from '@nestjs/common';

export class AwardWinDto {
  @IsString() @MinLength(1) @MaxLength(128)
  winnerId!: string;

  @IsOptional() @IsString() @MaxLength(140)
  note?: string;
}

@Controller('scores')
@UseGuards(JwtAuthGuard)
export class ScoresController {
  constructor(private readonly scores: ScoresService) {}

  /**
   * The client's boot call: all three current leaderboards in one response.
   * Paired with GET /users, that's the entire initial load.
   */
  @Get()
  async current(): Promise<{
    allTime: ScoreboardFile;
    monthly: ScoreboardFile;
    daily: ScoreboardFile;
    periods: { month: string; day: string };
  }> {
    const boards = await this.scores.readCurrentBoards();
    return { ...boards, periods: { month: monthKey(), day: dayKey() } };
  }

  /** Every persisted board, for the archive/period picker. */
  @Get('boards')
  async boards(): Promise<Array<{ kind: string; key: string; label: string; totalPoints: number }>> {
    const boards = await this.scores.listBoards();
    return boards
      .map(({ kind, key, label, totalPoints }) => ({ kind, key, label, totalPoints }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  /** A specific period: 'all-time', 'YYYY-MM' or 'YYYY-MM-DD'. */
  @Get('board/:key')
  async board(@Param('key') key: string): Promise<ScoreboardFile> {
    const kind = periodKindOf(key);
    if (!kind) {
      throw new BadRequestException("Period must be 'all-time', 'YYYY-MM' or 'YYYY-MM-DD'");
    }
    return this.scores.readBoard(kind, key);
  }

  /**
   * Add Score. One award = one point to the chosen winner, and the write
   * cascades to every derived scoreboard plus the index.
   */
  @Post('award')
  async award(
    @Body() dto: AwardWinDto,
    @CurrentUser() actor: PublicUser,
  ): Promise<{
    win: { id: string; at: string };
    winner: { id: string; displayName: string; avatarUrl: string; accentColor: string; allTime: number };
    boards: { allTime: ScoreboardFile; monthly: ScoreboardFile; daily: ScoreboardFile };
  }> {
    const result = await this.scores.awardWin(dto.winnerId, actor.id, dto.note);
    const [allTime, monthly, daily] = result.boards;

    return {
      win: { id: result.win.id, at: result.win.at },
      winner: {
        id: result.winner.id,
        displayName: result.winner.displayName,
        avatarUrl: result.winner.avatarUrl,
        accentColor: result.winner.accentColor,
        allTime: result.winner.scores.allTime,
      },
      boards: { allTime, monthly, daily },
    };
  }

  /**
   * Force a full recomputation of every derived board from the user files.
   * Safe to call any time — useful after hand-editing or deleting a JSON file.
   *
   * Admin-only: it rewrites 40+ files while holding the global write mutex, so
   * a signed-in racer looping it would starve every award and profile edit.
   */
  @Post('rebuild')
  @UseGuards(AdminGuard)
  async rebuild(@Query('confirm') confirm?: string): Promise<{ rebuilt: number }> {
    if (confirm !== 'yes') {
      throw new BadRequestException('Pass ?confirm=yes to rebuild every scoreboard');
    }
    const boards = await this.scores.rebuildAll();
    return { rebuilt: boards.length };
  }
}
