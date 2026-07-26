import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { DatabaseModule } from './database/database.module';
import { IndexService } from './database/index.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ScoresModule } from './scores/scores.module';
import { ContentModule } from './content/content.module';
import { WebModule } from './web/web.module';
import { AdminGuard, JwtAuthGuard } from './auth/guards';
import { dayKey, monthKey, timezoneName } from './common/period.util';
import type { IndexFile } from '@scrapyard/shared';

@Controller()
class MetaController {
  constructor(private readonly index: IndexService) {}

  /** Public liveness probe. Deliberately leaks nothing but clock config. */
  @Get('health')
  health(): { status: 'ok'; timezone: string; day: string; month: string } {
    return { status: 'ok', timezone: timezoneName(), day: dayKey(), month: monthKey() };
  }

  /**
   * The database's own table of contents. Handy for debugging by eye — but it
   * lists every racer's email address, so it sits behind the admin guard rather
   * than being public.
   */
  @Get('database/index')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async databaseIndex(): Promise<IndexFile> {
    return this.index.read();
  }
}

@Module({
  imports: [
    /*
     * Loaded first so every downstream module's DI-time config read sees .env.
     *
     * Paths are absolute, derived from this file's own location, because the
     * process is started from different working directories depending on how you
     * run it — `npm start` from the repo root, `npm run dev` from apps/api,
     * `node dist/main.js` from /app in the container. A cwd-relative path would
     * silently find no .env in at least one of those.
     *
     * __dirname is apps/api/dist at runtime and apps/api/src under ts-node, so
     * '..' lands on apps/api either way.
     */
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(__dirname, '..', '.env.local'),
        resolve(__dirname, '..', '.env'),
        '.env.local',
        '.env',
      ],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ScoresModule,
    ContentModule,
    WebModule,
  ],
  controllers: [MetaController],
})
export class AppModule {}
