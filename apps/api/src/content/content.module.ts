import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { AdminContentController, ContentController } from './content.controller';
import { ExportController } from '../database/export.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  // ExportService itself is provided by the global DatabaseModule.
  controllers: [ContentController, AdminContentController, ExportController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
