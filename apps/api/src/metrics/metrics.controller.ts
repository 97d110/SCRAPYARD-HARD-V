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
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async all(): Promise<MetricDef[]> {
    return this.metrics.definitions();
  }

  @Post()
  async create(@Body() dto: CreateMetricDto): Promise<MetricDef> {
    return this.metrics.createMetric(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateMetricDto): Promise<MetricDef> {
    return this.metrics.updateMetric(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.metrics.deleteMetric(id);
  }
}
