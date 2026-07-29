import { Global, Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';

/**
 * Global, matching `DatabaseModule`/`LiveModule` — `PushService` is
 * cross-cutting infrastructure any controller might eventually fire a
 * notification through (today just `ScoresController`), so it's provided
 * once rather than threading an import through every feature module that
 * wants it.
 */
@Global()
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
