import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  IsHexColor,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/guards';
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
