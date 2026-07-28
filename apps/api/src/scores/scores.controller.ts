import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ScoresService } from './scores.service';
import type { PeriodKind, PublicUser, RecordGameResponse, Scoreboard } from '@scrapyard/shared';
import { dayKey, monthKey, periodKindOf } from '../common/period.util';

export class GameResultDto {
  @IsString() @MinLength(1) @MaxLength(128)
  racerId!: string;

  @IsInt() @Min(1) @Max(4)
  place!: number;

  /** Optional — a winner-only entry can skip it; defaults to 0 server-side. */
  @IsOptional() @IsInt() @Min(0) @Max(999)
  gameScore?: number;

  /** Captured metric values, keyed by metric id. Sanitised server-side. */
  @IsOptional() @IsObject()
  stats?: Record<string, number>;
}

export class KillEventDto {
  @IsString() @MinLength(1) @MaxLength(128)
  killerId!: string;

  @IsString() @MinLength(1) @MaxLength(128)
  victimId!: string;
}

export class RecordGameDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => GameResultDto)
  results!: GameResultDto[];

  /** The kill log — killer→victim pairs. Revenge is resolved server-side. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => KillEventDto)
  events?: KillEventDto[];

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

  /** Every period that has at least one game, for the archive picker. */
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
   * Record a race: 2–4 finishers with their place, in-game score and stats,
   * written as a single immutable `games` document. The boards in the response
   * are aggregated fresh.
   */
  @Post('record')
  async record(
    @Body() dto: RecordGameDto,
    @CurrentUser() actor: PublicUser,
  ): Promise<RecordGameResponse> {
    const result = await this.scores.recordGame({
      results: dto.results,
      events: dto.events,
      awardedBy: actor.id,
      note: dto.note,
    });
    const { allTime, monthly, daily } = result.boards;

    return {
      game: { id: result.game.id, at: result.game.at },
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
