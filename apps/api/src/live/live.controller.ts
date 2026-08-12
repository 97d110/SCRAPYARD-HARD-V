import { Controller, Get, Query } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import type { LivePollResponse } from '@scrapyard/shared';
import { JwtAuthGuard } from '../auth/guards';
import { LiveService } from './live.service';

export class PollLiveDto {
  /**
   * The highest sequence number this tab has already applied.
   *
   * Omitted on a tab's very first poll, which is answered with the current head
   * and `resync` — there is no history worth replaying to something that just
   * finished loading the whole state anyway.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  since?: number;
}

/**
 * The live channel's read side.
 *
 * Sits under `/api` for the same three reasons the WebSocket path did:
 * `serve-spa.ts` lets `/api/*` past the session gate, the service worker never
 * caches it, and Vite's dev proxy forwards it to Nest so the browser stays
 * same-origin and keeps sending the cookie.
 *
 * Guarded by `JwtAuthGuard` like every other read endpoint. The socket had to
 * authenticate its own upgrade by hand — a browser cannot set headers on a
 * WebSocket handshake — and checking `Origin` besides, since a handshake is not
 * subject to CORS. As an ordinary GET this is just a request like the others,
 * and both of those special cases disappear with it.
 */
@Controller('live')
@UseGuards(JwtAuthGuard)
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get('events')
  async events(@Query() query: PollLiveDto): Promise<LivePollResponse> {
    return this.live.poll(query.since);
  }
}
