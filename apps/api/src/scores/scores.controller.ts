import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ScoresService } from './scores.service';
import type { PeriodKind, PublicUser, Scoreboard } from '@scrapyard/shared';
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
    allTime: Scoreboard;
    monthly: Scoreboard;
    daily: Scoreboard;
    periods: { month: string; day: string };
  }> {
    const boards = await this.scores.readCurrentBoards();
    return { ...boards, periods: { month: monthKey(), day: dayKey() } };
  }

  /**
   * Every period that has at least one win, for the archive picker.
   *
   * Cheap now: two `distinct` calls rather than reading 40+ derived files.
   */
  @Get('boards')
  async boards(): Promise<Array<{ kind: PeriodKind; key: string }>> {
    return this.scores.listPeriods();
  }

  /** A specific period: 'all-time', 'YYYY-MM' or 'YYYY-MM-DD'. */
  @Get('board/:key')
  async board(@Param('key') key: string): Promise<Scoreboard> {
    const kind = periodKindOf(key);
    if (!kind) {
      throw new BadRequestException("Period must be 'all-time', 'YYYY-MM' or 'YYYY-MM-DD'");
    }
    return this.scores.readBoard(kind, key);
  }

  /**
   * Add Score. One award = one point, recorded as a single immutable `wins`
   * document — an atomic insert with no lock and no cascade. The boards in the
   * response are aggregated fresh.
   */
  @Post('award')
  async award(
    @Body() dto: AwardWinDto,
    @CurrentUser() actor: PublicUser,
  ): Promise<{
    win: { id: string; at: string };
    winner: { id: string; displayName: string; avatarUrl: string; accentColor: string; allTime: number };
    boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
  }> {
    const result = await this.scores.awardWin(dto.winnerId, actor.id, dto.note);
    const { allTime, monthly, daily } = result.boards;

    return {
      win: { id: result.win.id, at: result.win.at },
      winner: {
        id: result.winner.id,
        displayName: result.winner.displayName,
        avatarUrl: result.winner.avatarUrl,
        accentColor: result.winner.accentColor,
        allTime: result.allTime,
      },
      boards: { allTime, monthly, daily },
    };
  }

}
