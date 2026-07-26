import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard, CurrentUser, JwtAuthGuard } from '../auth/guards';
import { ExportService } from './export.service';
import type { PublicUser } from '@scrapyard/shared';

/**
 * Database export. Admin-only — the archive contains every racer's email
 * address and full win history.
 */
@Controller('admin/export')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  /** What the download will contain, for the admin card. */
  @Get('summary')
  async summary(): Promise<{
    users: number;
    scoreboards: number;
    content: number;
    index: number;
    totalBytes: number;
    filename: string;
  }> {
    return { ...(await this.exporter.summary()), filename: this.exporter.filename() };
  }

  /**
   * Stream the whole JSON database as a zip.
   *
   * `@Res()` without `passthrough` hands us the raw response, which is what we
   * want: the archive is piped directly so nothing is buffered in memory, and
   * Nest won't try to serialise a return value on top of it.
   */
  @Get('database.zip')
  async download(
    @Res() response: Response,
    @CurrentUser() actor: PublicUser,
  ): Promise<void> {
    const filename = this.exporter.filename();

    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Compressed already, and the contents change constantly.
    response.setHeader('Cache-Control', 'no-store');
    // Lets the browser read the filename back off a fetch()-driven download.
    response.setHeader('X-Scrapyard-Filename', filename);
    response.setHeader('Access-Control-Expose-Headers', 'X-Scrapyard-Filename');

    await this.exporter.streamTo(response, actor.email);
  }
}
