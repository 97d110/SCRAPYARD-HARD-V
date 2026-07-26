import { Global, Module, OnModuleInit } from '@nestjs/common';
import { JsonStoreService } from './json-store.service';
import { IndexService } from './index.service';
import { ScoreboardBuilder } from './scoreboard.builder';
import { ExportService } from './export.service';

@Global()
@Module({
  providers: [JsonStoreService, IndexService, ScoreboardBuilder, ExportService],
  exports: [JsonStoreService, IndexService, ScoreboardBuilder, ExportService],
})
export class DatabaseModule implements OnModuleInit {
  constructor(private readonly store: JsonStoreService) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureLayout();
  }
}
