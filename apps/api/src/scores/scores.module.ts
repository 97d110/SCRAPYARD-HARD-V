import { Module } from '@nestjs/common';
import { ScoresService } from './scores.service';
import { AdminGamesController, ScoresController } from './scores.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [ScoresController, AdminGamesController],
  providers: [ScoresService],
  exports: [ScoresService],
})
export class ScoresModule {}
