import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import archiver from 'archiver';
import { JsonStoreService } from './json-store.service';
import { IndexService } from './index.service';
import { dayKey, timezoneName } from '../common/period.util';

export interface ExportManifest {
  exportedAt: string;
  exportedBy: string;
  timezone: string;
  /** Relative path -> byte size, for a quick integrity eyeball. */
  files: Record<string, number>;
  counts: { users: number; scoreboards: number; content: number; index: number };
}

/**
 * Streams the entire lo-fi JSON database out as a zip.
 *
 * Streamed rather than buffered: the archive is piped straight to the HTTP
 * response, so memory stays flat no matter how many racers and historical
 * boards have accumulated.
 *
 * The export runs inside a store transaction. That matters — without it, a
 * concurrent score award could land between reading `users/` and reading
 * `scores/`, producing a backup where the boards disagree with the user files.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly store: JsonStoreService,
    private readonly index: IndexService,
  ) {}

  /** Suggested download filename, e.g. `scrapyard-database-2026-07-26.zip`. */
  filename(): string {
    return `scrapyard-database-${dayKey()}.zip`;
  }

  /**
   * Pipe a zip of the whole database into `response`.
   *
   * Headers must already be sent by the caller — once the stream starts we
   * cannot switch to a JSON error body, so any failure mid-stream can only
   * abort the connection (which leaves the client with a truncated,
   * detectably-invalid zip rather than silently-wrong data).
   */
  async streamTo(response: Response, actorEmail: string): Promise<void> {
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('warning', (error) => {
      // ENOENT here means a file vanished mid-walk; worth knowing, not fatal.
      this.logger.warn(`Archive warning: ${error.message}`);
    });
    archive.on('error', (error) => {
      this.logger.error(`Archive failed: ${error.message}`);
      response.destroy(error);
    });

    archive.pipe(response);

    await this.store.transaction(async () => {
      const files: Record<string, number> = {};

      for (const dir of ['users', 'scores', 'content', 'index'] as const) {
        for (const name of await this.store.list(dir)) {
          const relative = `${dir}/${name}`;
          // Read through the store so the path-containment guard applies.
          const contents = await this.store.read<unknown>(relative);
          if (contents === null) continue;

          const body = `${JSON.stringify(contents, null, 2)}\n`;
          files[relative] = Buffer.byteLength(body, 'utf8');
          archive.append(body, { name: `database/${relative}` });
        }
      }

      const snapshot = await this.index.read();
      const manifest: ExportManifest = {
        exportedAt: new Date().toISOString(),
        exportedBy: actorEmail,
        timezone: timezoneName(),
        files,
        counts: {
          users: Object.keys(files).filter((f) => f.startsWith('users/')).length,
          scoreboards: Object.keys(files).filter((f) => f.startsWith('scores/')).length,
          content: Object.keys(files).filter((f) => f.startsWith('content/')).length,
          index: Object.keys(files).filter((f) => f.startsWith('index/')).length,
        },
      };

      archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
      archive.append(readmeText(manifest, snapshot.updatedAt), { name: 'README.txt' });

      this.logger.log(
        `Database export by ${actorEmail}: ${Object.keys(files).length} files`,
      );
    });

    await archive.finalize();
  }

  /** Byte-accurate counts without building the archive — used for the UI. */
  async summary(): Promise<ExportManifest['counts'] & { totalBytes: number }> {
    let totalBytes = 0;
    const counts = { users: 0, scoreboards: 0, content: 0, index: 0 };

    for (const [dir, key] of [
      ['users', 'users'],
      ['scores', 'scoreboards'],
      ['content', 'content'],
      ['index', 'index'],
    ] as const) {
      for (const name of await this.store.list(dir)) {
        const contents = await this.store.read<unknown>(`${dir}/${name}`);
        if (contents === null) continue;
        counts[key] += 1;
        totalBytes += Buffer.byteLength(`${JSON.stringify(contents, null, 2)}\n`, 'utf8');
      }
    }

    return { ...counts, totalBytes };
  }
}

function readmeText(manifest: ExportManifest, indexUpdatedAt: string): string {
  const total = Object.keys(manifest.files).length;
  return `Scrapyard database export
=========================

Exported at : ${manifest.exportedAt}
Exported by : ${manifest.exportedBy}
Timezone    : ${manifest.timezone}
Index built : ${indexUpdatedAt}
Files       : ${total}

Layout
------
database/users/      One file per racer. THE SOURCE OF TRUTH.
database/scores/     Derived leaderboards, one file per period.
database/content/    Editable site content (banner puns).
database/index/      Pointers to every file above. Derived.
manifest.json        This export's file list with byte sizes.

Restoring
---------
1. Stop the API.
2. Copy the contents of database/ over your DATABASE_DIR.
3. Start the API.
4. POST /api/scores/rebuild?confirm=yes  (admin session required)

Step 4 regenerates every file under scores/ and index/ from the user files, so
you only strictly need to restore database/users/ and database/content/. If the
derived files disagree with the user files for any reason, the rebuild is
authoritative.
`;
}
