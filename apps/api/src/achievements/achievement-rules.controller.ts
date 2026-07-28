import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminGuard, JwtAuthGuard } from '../auth/guards';
import { AchievementRulesService } from './achievement-rules.service';
import type { AchievementRule } from '@scrapyard/shared';

export class CreateRuleDto {
  @IsString() @MinLength(1) @MaxLength(40)
  name!: string;

  @IsOptional() @IsString() @MaxLength(160)
  description?: string;

  @IsOptional() @IsIn(['bronze', 'silver', 'gold', 'plasma'])
  tier?: string;

  @IsOptional() @IsString() @MaxLength(40)
  icon?: string;

  @IsString() @MinLength(1) @MaxLength(31)
  metricId!: string;

  @IsIn(['all-time', 'monthly', 'daily', 'game'])
  scope!: string;

  @IsNumber() @IsPositive()
  threshold!: number;
}

export class UpdateRuleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  name?: string;

  @IsOptional() @IsString() @MaxLength(160)
  description?: string;

  @IsOptional() @IsIn(['bronze', 'silver', 'gold', 'plasma'])
  tier?: string;

  @IsOptional() @IsString() @MaxLength(40)
  icon?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(31)
  metricId?: string;

  @IsOptional() @IsIn(['all-time', 'monthly', 'daily', 'game'])
  scope?: string;

  @IsOptional() @IsNumber() @IsPositive()
  threshold?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsNumber()
  order?: number;
}

/** Admin surface — the data-driven achievement rules and their editor. */
@Controller('admin/achievement-rules')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminAchievementRulesController {
  constructor(private readonly rules: AchievementRulesService) {}

  @Get()
  async all(): Promise<AchievementRule[]> {
    return this.rules.rules();
  }

  @Post()
  async create(@Body() dto: CreateRuleDto): Promise<AchievementRule> {
    return this.rules.createRule(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateRuleDto): Promise<AchievementRule> {
    return this.rules.updateRule(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.rules.deleteRule(id);
  }
}
