import {
  Body,
  Controller,
  Delete,
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
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AdminGuard, JwtAuthGuard } from '../auth/guards';
import { ContentService, ContentTypeDescriptor } from './content.service';
import { ExportService } from '../database/export.service';
import type { Pun } from '@scrapyard/shared';
import { AchievementsService } from '../achievements/achievements.service';
import { RACERS } from '../users/users.service';

export class CreatePunDto {
  @IsString() @MinLength(3) @MaxLength(160)
  text!: string;
}

export class UpdatePunDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160)
  text?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class ReorderPunsDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true })
  ids!: string[];
}

/** Public (session-guarded) content the banner reads. */
@Controller('content')
@UseGuards(JwtAuthGuard)
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('puns')
  async puns(): Promise<Pun[]> {
    return this.content.listEnabledPuns();
  }
}

/** Admin surface — the grid of content types plus the puns editor. */
@Controller('admin/content')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminContentController {
  constructor(
    private readonly content: ContentService,
    private readonly achievements: AchievementsService,
    private readonly exporter: ExportService,
  ) {}

  /** Cards for the searchable grid menu. */
  @Get('types')
  async types(): Promise<ContentTypeDescriptor[]> {
    const summary = await this.exporter.summary();
    const fileCount =
      summary.users + summary.scoreboards + summary.content + summary.index;
    return this.content.describeTypes(fileCount);
  }

  /** Read-only previews so the non-editable cards still show something useful. */
  @Get('types/:id/preview')
  async preview(@Param('id') id: string): Promise<{ id: string; items: unknown[] }> {
    if (id === 'achievements') {
      return { id, items: this.achievements.definitions() };
    }
    if (id === 'racers') {
      return { id, items: [...RACERS].map((name) => ({ name })) };
    }
    return { id, items: [] };
  }

  @Get('puns')
  async list(): Promise<Pun[]> {
    return this.content.listAllPuns();
  }

  @Post('puns')
  async create(@Body() dto: CreatePunDto): Promise<Pun> {
    return this.content.createPun(dto.text);
  }

  @Patch('puns/:id')
  async update(@Param('id') id: string, @Body() dto: UpdatePunDto): Promise<Pun> {
    return this.content.updatePun(id, dto);
  }

  @Delete('puns/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.content.deletePun(id);
  }

  @Post('puns/reorder')
  async reorder(@Body() dto: ReorderPunsDto): Promise<Pun[]> {
    return this.content.reorderPuns(dto.ids);
  }
}
