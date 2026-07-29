import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { CurrentUser, JwtAuthGuard } from '../auth/guards';
import { PushService } from './push.service';
import type { PublicUser } from '@scrapyard/shared';

class PushKeysDto {
  @IsString() @MaxLength(200)
  p256dh!: string;

  @IsString() @MaxLength(200)
  auth!: string;
}

class SubscribeDto {
  @IsString() @MaxLength(2000)
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

class UnsubscribeDto {
  @IsString() @MaxLength(2000)
  endpoint!: string;
}

/**
 * Every route here still sits behind a session (`JwtAuthGuard`) even though
 * `public-key` isn't sensitive — this app has no unauthenticated surface at
 * all, and carving one out for a single low-value read isn't worth being the
 * one exception.
 */
@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Null when the server has no VAPID keys configured — hides the toggle client-side. */
  @Get('public-key')
  publicKey(): { publicKey: string | null } {
    return { publicKey: this.push.publicKey() };
  }

  @Post('subscribe')
  @HttpCode(204)
  async subscribe(
    @Body() dto: SubscribeDto,
    @CurrentUser() actor: PublicUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.push.subscribe(actor.id, dto, request.headers['user-agent']);
  }

  @Delete('subscribe')
  @HttpCode(204)
  async unsubscribe(@Body() dto: UnsubscribeDto, @CurrentUser() actor: PublicUser): Promise<void> {
    await this.push.unsubscribe(actor.id, dto.endpoint);
  }
}
