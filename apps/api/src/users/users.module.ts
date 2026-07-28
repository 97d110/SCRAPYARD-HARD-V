import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { AdminUsersController, UsersController } from './users.controller';
import { AchievementsService } from '../achievements/achievements.service';

@Module({
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService, AchievementsService],
  exports: [UsersService, AchievementsService],
})
export class UsersModule {}
