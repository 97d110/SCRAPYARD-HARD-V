import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ScoresModule } from './scores/scores.module';
import { ContentModule } from './content/content.module';
import { ConfigEditorModule } from './config/config-editor.module';
import { WebModule } from './web/web.module';
import { LiveModule } from './live/live.module';
import { LiveGateway } from './live/live.gateway';
import { PushModule } from './push/push.module';
import { dayKey, monthKey, timezoneName } from './common/period.util';

@Controller()
class MetaController {
  constructor(private readonly live: LiveGateway) {}

  /**
   * Public liveness probe. Deliberately leaks nothing but clock, db name and a
   * socket count — the last of which is the only way to tell, on a free
   * instance with no shell, whether the live channel is actually carrying
   * anyone.
   */
  @Get('health')
  health(): {
    status: 'ok';
    timezone: string;
    day: string;
    month: string;
    database: string;
    liveClients: number;
  } {
    return {
      status: 'ok',
      timezone: timezoneName(),
      day: dayKey(),
      month: monthKey(),
      database: process.env.MONGODB_DB || 'scrapyard',
      liveClients: this.live.connectionCount,
    };
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
    ConfigEditorModule,
    WebModule,
    LiveModule,
    PushModule,
  ],
  controllers: [MetaController],
})
export class AppModule {}
