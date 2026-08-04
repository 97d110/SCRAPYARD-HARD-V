import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ClientId } from '../live/client-id.decorator';
import { LiveGateway } from '../live/live.gateway';
import { UsersService } from './users.service';
import { RACERS, RACER_NAMES } from '../common/racers';
import { RACE_COLORS } from '../common/race-colors';
import { AchievementsService } from '../achievements/achievements.service';
import type { ProfileBundle, PublicUser, RaceColor } from '@scrapyard/shared';

export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40)
  displayName?: string;

  /** https URL or a data:image/... URL from the client cropper. */
  @IsOptional() @IsString() @MaxLength(1_400_000)
  avatarUrl?: string;

  @IsOptional() @IsString() @MaxLength(120)
  tagline?: string;

  @IsOptional() @IsIn(RACER_NAMES)
  favoriteRacer?: string;

  /** One of the four in-game car colours — also the racer's colour app-wide. */
  @IsOptional() @IsIn(RACE_COLORS as unknown as string[])
  raceColor?: RaceColor;

  /** Show this racer's art instead of the photo. See ProfilePatch. */
  @IsOptional() @IsBoolean()
  useRacerArt?: boolean;

  /** Trimmed, de-duplicated and length-checked in the service. */
  @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(40, { each: true })
  hebrewAliases?: string[];
}

export class CreateRacerDto {
  @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @MinLength(2) @MaxLength(40)
  displayName!: string;
}

/**
 * Admin: manage the roster.
 *
 * Separate controller from `/users` so the admin routes carry AdminGuard by
 * declaration rather than by a check inside each handler — nobody can add a
 * method here and forget the guard.
 */
@Controller('admin/users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly live: LiveGateway,
  ) {}

  /** Add a racer by email before they've ever signed in. */
  @Post()
  async create(@Body() dto: CreateRacerDto, @ClientId() origin?: string): Promise<PublicUser> {
    const created = await this.users.createUnclaimed(dto);
    // A new seat is on every board immediately, at zero wins.
    this.live.broadcast({
      type: 'roster:changed',
      origin,
      reason: 'created',
      userId: created.id,
    });
    return created;
  }

  /**
   * Admin: edit any racer's profile.
   *
   * The self-only rule on `PATCH /users/:id` is the right default, but it left
   * no way to fill in the fields voice entry depends on for a racer who hasn't
   * signed in yet — an unclaimed seat can't edit itself. Same DTO and same
   * service method, so validation can't drift between the two routes.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
    @ClientId() origin?: string,
  ): Promise<PublicUser> {
    const updated = await this.users.updateProfile(id, dto);
    // Same reason code as a self-edit — it's the same kind of change to the
    // same fields, and every client refreshes the roster identically either way.
    this.live.broadcast({ type: 'roster:changed', origin, reason: 'profile', userId: id });
    return updated;
  }

  /** Undo a typo. Only works while the seat is unclaimed and has no wins. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @ClientId() origin?: string): Promise<void> {
    await this.users.deleteUnclaimed(id);
    this.live.broadcast({ type: 'roster:changed', origin, reason: 'deleted', userId: id });
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly achievements: AchievementsService,
    private readonly live: LiveGateway,
  ) {}

  /** The full roster. Fetched once on client boot. */
  @Get()
  async list(): Promise<PublicUser[]> {
    return this.users.findAll();
  }

  /** Options the profile editor renders. */
  @Get('options')
  options(): { racers: Array<{ name: string; slug: string }> } {
    // Slugs travel with the names: the client keys art off them, and deriving
    // them separately would risk two slugify implementations disagreeing.
    return { racers: RACERS.map((racer) => ({ ...racer })) };
  }

  /** Anyone signed in can view anyone's achievements page. */
  @Get(':id')
  async profile(@Param('id') id: string): Promise<ProfileBundle> {
    return this.achievements.buildProfile(id);
  }

  /** You may only edit your own profile. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
    @CurrentUser() actor: PublicUser,
    @ClientId() origin?: string,
  ): Promise<PublicUser> {
    if (actor.id !== id) {
      throw new ForbiddenException('You can only edit your own profile');
    }
    const updated = await this.users.updateProfile(id, dto);
    /*
     * Worth broadcasting even though nothing about the *scores* moved: rows join
     * the user document at query time, so a rename or a new accent changes every
     * board and every rival list on screen. This is the cascade the aggregate-on-
     * read model spares the database, arriving at the clients instead.
     */
    this.live.broadcast({ type: 'roster:changed', origin, reason: 'profile', userId: id });
    return updated;
  }
}
