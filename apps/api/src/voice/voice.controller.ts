import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards';
import { VoiceService } from './voice.service';
import type { VoiceDraft } from '@scrapyard/shared';

export class VoiceDraftDto {
  /**
   * The browser's transcript. Bounded because it goes into a prompt: a race
   * summary is one sentence, and anything longer is either a mistake or someone
   * probing. The service enforces its own limit too — this is the cheap
   * rejection that happens before any work.
   */
  @IsString() @MinLength(1) @MaxLength(600)
  transcript!: string;
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

  /** Transcript in, draft form fields out. Records nothing. */
  @Post('draft')
  async draft(@Body() dto: VoiceDraftDto): Promise<VoiceDraft> {
    return this.voice.draftFromTranscript(dto.transcript);
  }
}
