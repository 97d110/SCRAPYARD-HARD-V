import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';
import { ScoreboardRepository } from './scoreboard.repository';
import { ExportService } from './export.service';
import { MetricsService } from '../metrics/metrics.service';
import { AchievementRulesService } from '../achievements/achievement-rules.service';

/**
 * Global, so any module can inject the collections and the metric/rule
 * registries without importing this one.
 *
 * The metric and achievement-rule services live here (rather than in their own
 * feature modules) because they're pure config repositories the scoreboard and
 * achievement engines depend on — keeping them global sidesteps a web of
 * cross-module imports and any risk of a circular dependency.
 *
 * There is deliberately no `OnModuleInit` doing setup work. On serverless the
 * module initialises on every cold start, so anything expensive here would be
 * paid for by an arbitrary user request. Both the connection and index creation
 * are lazy and cached — see MongoService.
 */
@Global()
@Module({
  providers: [MongoService, ScoreboardRepository, ExportService, MetricsService, AchievementRulesService],
  exports: [MongoService, ScoreboardRepository, ExportService, MetricsService, AchievementRulesService],
})
export class DatabaseModule {}
