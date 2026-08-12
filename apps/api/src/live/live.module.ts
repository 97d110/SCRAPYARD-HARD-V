import { Global, Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

/**
 * The live channel.
 *
 * Global, for the same reason DatabaseModule is: nearly every mutating
 * controller broadcasts, and threading an import of this through all six
 * feature modules would buy nothing.
 *
 * WebModule used to be imported here for `SessionReader`, because the WebSocket
 * upgrade had to authenticate itself. Polling is an ordinary guarded GET, so
 * that dependency is gone — and with it the DI cycle it used to skirt.
 */
@Global()
@Module({
  controllers: [LiveController],
  providers: [LiveService],
  exports: [LiveService],
})
export class LiveModule {}
