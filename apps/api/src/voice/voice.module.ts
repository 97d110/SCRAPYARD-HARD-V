import { Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { UsersModule } from '../users/users.module';

/**
 * Not `@Global()`, unlike PushModule: nothing else in the app fires a voice
 * extraction, so this stays a leaf feature module. It imports UsersModule
 * because the roster — display names plus Hebrew aliases — is what makes the
 * matching work, and that has to come from the same place the rest of the app
 * reads racers from rather than a second query written just for this.
 */
@Module({
  imports: [UsersModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
