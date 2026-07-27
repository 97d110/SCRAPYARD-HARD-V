import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';
import { ScoreboardRepository } from './scoreboard.repository';
import { ExportService } from './export.service';

/**
 * Global, so any module can inject the collections without importing this one.
 *
 * There is deliberately no `OnModuleInit` doing setup work. On serverless the
 * module initialises on every cold start, so anything expensive here would be
 * paid for by an arbitrary user request. Both the connection and index creation
 * are lazy and cached — see MongoService.
 */
@Global()
@Module({
  providers: [MongoService, ScoreboardRepository, ExportService],
  exports: [MongoService, ScoreboardRepository, ExportService],
})
export class DatabaseModule {}
