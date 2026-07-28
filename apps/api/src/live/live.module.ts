import { Global, Module } from '@nestjs/common';
import { LiveGateway } from './live.gateway';
import { WebModule } from '../web/web.module';

/**
 * The live channel.
 *
 * Global, for the same reason DatabaseModule is: nearly every mutating
 * controller broadcasts, and threading an import of this through all six
 * feature modules would buy nothing.
 *
 * WebModule comes in for `SessionReader` — the upgrade handshake is checked
 * with the exact same code that gates the SPA bundle, not a copy of it.
 */
@Global()
@Module({
  imports: [WebModule],
  providers: [LiveGateway],
  exports: [LiveGateway],
})
export class LiveModule {}
