import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './google.strategy';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module';
import { jwtSecret } from './jwt.strategy';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    /*
     * registerAsync, not register.
     *
     * `register({ secret: process.env.JWT_SECRET })` is evaluated when this
     * file is *required*, which happens before ConfigModule.forRoot() copies
     * .env into process.env. The signing side would silently fall back to the
     * dev default while JwtStrategy (constructed later, at DI time) picked up
     * the real value — every freshly-issued session would then fail
     * verification with a 401. registerAsync defers to DI time so both sides
     * resolve the same secret.
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: jwtSecret(config) }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleStrategy, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
