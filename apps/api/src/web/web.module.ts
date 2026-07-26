import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { LoginController } from './login.controller';
import { SessionReader } from './session-reader.service';
import { UsersModule } from '../users/users.module';
import { jwtSecret } from '../auth/jwt.strategy';

/**
 * Everything the browser talks to that isn't the JSON API: the server-rendered
 * login page, and the session check that gates the SPA bundle.
 */
@Module({
  imports: [
    UsersModule,
    // Same registerAsync pattern as AuthModule — the secret must be resolved at
    // DI time, after ConfigModule has loaded .env, or verification would use a
    // different secret than issuance.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: jwtSecret(config) }),
    }),
  ],
  controllers: [LoginController],
  providers: [SessionReader],
  exports: [SessionReader],
})
export class WebModule {}
