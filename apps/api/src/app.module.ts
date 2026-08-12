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
import { PushModule } from './push/push.module';
import { VoiceModule } from './voice/voice.module';
import { dayKey, monthKey, timezoneName } from './common/period.util';

@Controller()
class MetaController {
  /**
   * Public liveness probe. Deliberately leaks nothing but clock and db name.
   *
   * It used to report `liveClients` too, which on a single always-on process
   * was the only way to tell whether the live channel was carrying anyone. That
   * number has no meaning now: there are no held connections to count, and any
   * instance answering this would only ever see its own.
   */
  @Get('health')
  health(): {
    status: 'ok';
    timezone: string;
    day: string;
    month: string;
    database: string;
  } {
    return {
      status: 'ok',
      timezone: timezoneName(),
      day: dayKey(),
      month: monthKey(),
      database: process.env.MONGODB_DB || 'scrapyard',
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
    VoiceModule,
  ],
  controllers: [MetaController],
})
export class AppModule {}
