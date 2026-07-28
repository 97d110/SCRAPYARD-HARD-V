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
  IsEmail,
  IsHexColor,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ACCENT_COLORS, RACERS, UsersService } from './users.service';
import { AchievementsService } from '../achievements/achievements.service';
import type { ProfileBundle, PublicUser } from '@scrapyard/shared';

export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40)
  displayName?: string;

  /** https URL or a data:image/... URL from the client cropper. */
  @IsOptional() @IsString() @MaxLength(1_400_000)
  avatarUrl?: string;

  @IsOptional() @IsString() @MaxLength(120)
  tagline?: string;

  @IsOptional() @IsIn(RACERS as unknown as string[])
  favoriteRacer?: string;

  @IsOptional() @IsHexColor()
  accentColor?: string;
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
  constructor(private readonly users: UsersService) {}

  /** Add a racer by email before they've ever signed in. */
  @Post()
  async create(@Body() dto: CreateRacerDto): Promise<PublicUser> {
    return this.users.createUnclaimed(dto);
  }

  /** Undo a typo. Only works while the seat is unclaimed and has no wins. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    return this.users.deleteUnclaimed(id);
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly achievements: AchievementsService,
  ) {}

  /** The full roster. Fetched once on client boot. */
  @Get()
  async list(): Promise<PublicUser[]> {
    return this.users.findAll();
  }

  /** Options the profile editor renders. */
  @Get('options')
  options(): { racers: string[]; accents: string[] } {
    return { racers: [...RACERS], accents: [...ACCENT_COLORS] };
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
  ): Promise<PublicUser> {
    if (actor.id !== id) {
      throw new ForbiddenException('You can only edit your own profile');
    }
    return this.users.updateProfile(id, dto);
  }
}
