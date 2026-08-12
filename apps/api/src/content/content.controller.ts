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
import { ClientId } from '../live/client-id.decorator';
import { LiveService } from '../live/live.service';
import { ContentService, ContentTypeDescriptor } from './content.service';
import { ExportService } from '../database/export.service';
import type { Pun } from '@scrapyard/shared';
import { AchievementsService } from '../achievements/achievements.service';
import { MetricsService } from '../metrics/metrics.service';
import { RACER_NAMES } from '../common/racers';

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
    private readonly metrics: MetricsService,
    private readonly exporter: ExportService,
    private readonly live: LiveService,
  ) {}

  /** Cards for the searchable grid menu. */
  @Get('types')
  async types(): Promise<ContentTypeDescriptor[]> {
    const [summary, achDefs, metricDefs] = await Promise.all([
      this.exporter.summary(),
      this.achievements.definitions(),
      this.metrics.definitions(),
    ]);
    const documents = summary.users + summary.games + summary.content;
    return this.content.describeTypes(documents, achDefs.length, metricDefs.length);
  }

  /** Read-only previews so the non-editable cards still show something useful. */
  @Get('types/:id/preview')
  async preview(@Param('id') id: string): Promise<{ id: string; items: unknown[] }> {
    if (id === 'achievements') {
      return { id, items: await this.achievements.definitions() };
    }
    if (id === 'metrics') {
      return { id, items: await this.metrics.definitions() };
    }
    if (id === 'racers') {
      return { id, items: RACER_NAMES.map((name) => ({ name })) };
    }
    return { id, items: [] };
  }

  @Get('puns')
  async list(): Promise<Pun[]> {
    return this.content.listAllPuns();
  }

  /*
   * Every pun mutation below broadcasts the same event: the ticker at the top of
   * every open tab reads this list, so an edit here should reach the wall display
   * without anyone reloading it.
   */

  @Post('puns')
  async create(@Body() dto: CreatePunDto, @ClientId() origin?: string): Promise<Pun> {
    const pun = await this.content.createPun(dto.text);
    await this.live.broadcast({ type: 'puns:changed', origin });
    return pun;
  }

  @Patch('puns/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePunDto,
    @ClientId() origin?: string,
  ): Promise<Pun> {
    const pun = await this.content.updatePun(id, dto);
    await this.live.broadcast({ type: 'puns:changed', origin });
    return pun;
  }

  @Delete('puns/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @ClientId() origin?: string): Promise<void> {
    await this.content.deletePun(id);
    await this.live.broadcast({ type: 'puns:changed', origin });
  }

  @Post('puns/reorder')
  async reorder(@Body() dto: ReorderPunsDto, @ClientId() origin?: string): Promise<Pun[]> {
    const puns = await this.content.reorderPuns(dto.ids);
    await this.live.broadcast({ type: 'puns:changed', origin });
    return puns;
  }
}
