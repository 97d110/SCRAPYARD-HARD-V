import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
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
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ClientId } from '../live/client-id.decorator';
import { LiveGateway } from '../live/live.gateway';
import { PushService } from '../push/push.service';
import { ScoresService } from './scores.service';
import type {
  DeleteGameResponse,
  GamesPage,
  PeriodKind,
  PublicUser,
  RecordGameResponse,
  Scoreboard,
} from '@scrapyard/shared';
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
  constructor(
    private readonly scores: ScoresService,
    private readonly live: LiveGateway,
    private readonly push: PushService,
  ) {}

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
    @ClientId() origin?: string,
  ): Promise<RecordGameResponse> {
    const result = await this.scores.recordGame({
      results: dto.results,
      events: dto.events,
      awardedBy: actor.id,
      note: dto.note,
    });
    const { allTime, monthly, daily } = result.boards;

    const winner = {
      id: result.winner.id,
      displayName: result.winner.displayName,
      avatarUrl: result.winner.avatarUrl,
      raceColor: result.winner.raceColor,
      allTime: result.allTime,
    };

    /*
     * The hottest event on the wire: every other tab refetches its boards and
     * runs the winner's flyby. The recording tab has all of this in the response
     * below already, so it drops the echo on `origin`.
     */
    this.live.broadcast({ type: 'game:recorded', origin, gameId: result.game.id, winner });

    // Fire-and-forget: a push failure, or the feature being unconfigured,
    // must never affect the response a racer is waiting on.
    void this.push.notifyRaceRecorded({
      winnerName: winner.displayName,
      finishers: result.game.results.length,
      note: result.game.note,
    });

    return {
      game: { id: result.game.id, at: result.game.at },
      winner,
      boards: { allTime, monthly, daily },
    };
  }
}

/**
 * Admin: browse and delete recorded games.
 *
 * Separate controller from `ScoresController`, same reasoning as
 * `AdminUsersController` — the guard is on the class, not repeated per method,
 * so a new handler here can't accidentally ship without it.
 */
@Controller('admin/games')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminGamesController {
  constructor(
    private readonly scores: ScoresService,
    private readonly live: LiveGateway,
  ) {}

  /** Newest-first race log, optionally scoped to one day. Cursor-paginated. */
  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('day') day?: string,
  ): Promise<GamesPage> {
    return this.scores.listGames({
      limit: limit ? Number(limit) : undefined,
      before,
      day,
    });
  }

  /**
   * Delete a game. Boards/achievements need no cascade — they're aggregated
   * fresh on read — but same-day revenge tags are write-time-resolved, so the
   * rest of that day gets recomputed. See `ScoresService.deleteGame`.
   */
  @Delete(':id')
  @HttpCode(200)
  async remove(
    @Param('id') id: string,
    @ClientId() origin?: string,
  ): Promise<DeleteGameResponse> {
    const result = await this.scores.deleteGame(id);
    // Deleting a race moves every board it touched, and any profile page open
    // on one of its finishers.
    this.live.broadcast({
      type: 'game:deleted',
      origin,
      gameId: result.deletedId,
      dayKey: result.dayKey,
    });
    return result;
  }
}
