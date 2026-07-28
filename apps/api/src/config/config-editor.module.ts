import { Module } from '@nestjs/common';
import { AdminMetricsController, MetricsController } from '../metrics/metrics.controller';
import { AdminAchievementRulesController } from '../achievements/achievement-rules.controller';

/**
 * The admin-configurable half of the metric engine: metric definitions and
 * achievement rules. The services these controllers use (MetricsService,
 * AchievementRulesService) are provided globally by DatabaseModule, so this
 * module only needs to register the controllers.
 *
 * Named `config-editor` to avoid colliding with Nest's own ConfigModule.
 */
@Module({
  controllers: [MetricsController, AdminMetricsController, AdminAchievementRulesController],
})
export class ConfigEditorModule {}
