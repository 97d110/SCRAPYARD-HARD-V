import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdminGuard, JwtAuthGuard } from '../auth/guards';
import { ClientId } from '../live/client-id.decorator';
import { LiveGateway } from '../live/live.gateway';
import { MetricsService } from './metrics.service';
import type { MetricDef } from '@scrapyard/shared';

export class FormulaTermDto {
  @IsString() @MinLength(1) @MaxLength(31)
  metricId!: string;

  @IsNumber()
  weight!: number;
}

export class CreateMetricDto {
  @IsString() @MinLength(2) @MaxLength(31)
  id!: string;

  @IsString() @MinLength(1) @MaxLength(40)
  label!: string;

  @IsIn(['captured', 'formula'])
  kind!: 'captured' | 'formula';

  @IsOptional() @IsString() @MaxLength(40)
  icon?: string;

  @IsOptional() @IsString() @MaxLength(16)
  unit?: string;

  @IsOptional() @IsString() @MaxLength(160)
  description?: string;

  @IsOptional() @IsIn(['sum', 'max', 'avg', 'last'])
  aggregation?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FormulaTermDto)
  formula?: FormulaTermDto[];
}

export class UpdateMetricDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  label?: string;

  @IsOptional() @IsString() @MaxLength(40)
  icon?: string;

  @IsOptional() @IsString() @MaxLength(16)
  unit?: string;

  @IsOptional() @IsString() @MaxLength(160)
  description?: string;

  @IsOptional() @IsIn(['sum', 'max', 'avg', 'last'])
  aggregation?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FormulaTermDto)
  formula?: FormulaTermDto[];

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsNumber()
  order?: number;
}

/** Session-guarded read: the race-entry form needs the captured metric list. */
@Controller('metrics')
@UseGuards(JwtAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async list(): Promise<MetricDef[]> {
    return (await this.metrics.definitions()).filter((m) => m.enabled);
  }
}

/** Admin surface — the full metric registry and its editor. */
@Controller('admin/metrics')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminMetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly live: LiveGateway,
  ) {}

  @Get()
  async all(): Promise<MetricDef[]> {
    return this.metrics.definitions();
  }

  /*
   * A metric is a *column* on every leaderboard and a term other formulas can
   * reference, so each of these three changes the shape of what other tabs are
   * looking at — not just a number in it.
   */

  @Post()
  async create(@Body() dto: CreateMetricDto, @ClientId() origin?: string): Promise<MetricDef> {
    const metric = await this.metrics.createMetric(dto);
    this.live.broadcast({ type: 'metrics:changed', origin });
    return metric;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateMetricDto,
    @ClientId() origin?: string,
  ): Promise<MetricDef> {
    const metric = await this.metrics.updateMetric(id, dto);
    this.live.broadcast({ type: 'metrics:changed', origin });
    return metric;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @ClientId() origin?: string): Promise<void> {
    await this.metrics.deleteMetric(id);
    this.live.broadcast({ type: 'metrics:changed', origin });
  }
}
