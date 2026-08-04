import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, JwtAuthGuard } from '../auth/guards';
import { VoiceService } from './voice.service';
import type { PublicUser, VoiceDraft } from '@scrapyard/shared';

export class VoiceDraftDto {
  /**
   * The recording, as a `data:audio/...;base64,…` URL — the same inline-file
   * shape the avatar upload uses, so there's no multipart plumbing to add.
   *
   * Bounded at roughly 2.7MB of base64 (~2MB of audio, about a minute of Opus).
   * The service re-checks the decoded length; this is the cheap rejection that
   * happens before anything is decoded at all.
   */
  @IsString() @MinLength(1) @MaxLength(2_800_000)
  audio!: string;
}

/**
 * Voice race entry.
 *
 * Signed-in only, like everything else that reads the roster — the roster goes
 * into the extraction request, so an open endpoint here would leak the crew
 * list to anyone who could POST to it.
 */
@Controller('voice')
@UseGuards(JwtAuthGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /**
   * Whether the feature is switched on at all. The client asks once and hides
   * the mic button entirely when it isn't — the same shape as the push
   * notification toggle, so an unconfigured deployment shows no dead controls.
   */
  @Get('status')
  status(): { available: boolean } {
    return { available: this.voice.available() };
  }

  /**
   * Recording in, draft form fields out. Records nothing.
   *
   * The caller's own id goes along so first-person speech resolves — someone
   * saying "ניצחתי עם 16" ("I won with 16") means themselves, and the server
   * knows who that is from the session rather than needing it said aloud.
   */
  @Post('draft')
  async draft(@Body() dto: VoiceDraftDto, @CurrentUser() actor: PublicUser): Promise<VoiceDraft> {
    return this.voice.draftFromAudio(dto.audio, actor.id);
  }
}
