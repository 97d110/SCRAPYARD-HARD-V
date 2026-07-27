import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import archiver from 'archiver';
import { MongoService } from './mongo.service';
import { dayKey, timezoneName } from '../common/period.util';

export interface ExportManifest {
  exportedAt: string;
  exportedBy: string;
  timezone: string;
  database: string;
  /** Collection name -> document count. */
  counts: Record<string, number>;
  /** Collection name -> byte size of the exported JSON. */
  bytes: Record<string, number>;
}

/** Collections dumped, in the order they appear in the archive. */
const COLLECTIONS = ['users', 'wins', 'content'] as const;

/**
 * Streams the whole database out as a zip of JSON files.
 *
 * Streamed rather than buffered, so memory stays flat however many wins have
 * accumulated — each collection is written from a cursor one document at a
 * time, never materialised as an array.
 *
 * Unlike the old file-based exporter, this needs no lock. `wins` is append-only
 * and the other collections change rarely, so a concurrent award can at worst
 * mean one extra win lands in the archive. There is no derived state that could
 * come out internally inconsistent.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(private readonly mongo: MongoService) {}

  /** Suggested download filename, e.g. `scrapyard-2026-07-26.zip`. */
  filename(): string {
    return `scrapyard-${dayKey()}.zip`;
  }

  /**
   * Pipe a zip of every collection into `response`.
   *
   * Headers must already be sent by the caller — once the stream starts we
   * cannot switch to a JSON error body, so a mid-stream failure can only abort
   * the connection. That leaves a truncated, detectably-invalid zip rather than
   * silently-wrong data.
   */
  async streamTo(response: Response, actorEmail: string): Promise<void> {
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('warning', (error) => this.logger.warn(`Archive warning: ${error.message}`));
    archive.on('error', (error) => {
      this.logger.error(`Archive failed: ${error.message}`);
      response.destroy(error);
    });

    archive.pipe(response);

    const db = await this.mongo.db();
    const counts: Record<string, number> = {};
    const bytes: Record<string, number> = {};

    for (const name of COLLECTIONS) {
      const cursor = db.collection(name).find({});
      const parts: string[] = ['[\n'];
      let first = true;
      let n = 0;

      for await (const doc of cursor) {
        parts.push(`${first ? '' : ',\n'}  ${JSON.stringify(doc)}`);
        first = false;
        n += 1;
      }
      parts.push('\n]\n');

      const body = parts.join('');
      counts[name] = n;
      bytes[name] = Buffer.byteLength(body, 'utf8');
      archive.append(body, { name: `database/${name}.json` });
    }

    const manifest: ExportManifest = {
      exportedAt: new Date().toISOString(),
      exportedBy: actorEmail,
      timezone: timezoneName(),
      database: process.env.MONGODB_DB || 'scrapyard',
      counts,
      bytes,
    };

    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
    archive.append(readmeText(manifest), { name: 'README.txt' });

    this.logger.log(
      `Export by ${actorEmail}: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );

    await archive.finalize();
  }

  /** Counts without building the archive — drives the admin card. */
  async summary(): Promise<{
    users: number;
    wins: number;
    content: number;
    totalBytes: number;
  }> {
    const db = await this.mongo.db();
    const stats = await Promise.all(
      COLLECTIONS.map(async (name) => [name, await db.collection(name).countDocuments()] as const),
    );

    const counts = Object.fromEntries(stats) as Record<(typeof COLLECTIONS)[number], number>;

    /*
     * A rough estimate rather than a real measurement. `collStats` needs
     * elevated privileges an Atlas application user typically doesn't have, and
     * this only drives a number on a card.
     */
    const totalBytes = counts.users * 400 + counts.wins * 200 + counts.content * 6000;

    return { users: counts.users, wins: counts.wins, content: counts.content, totalBytes };
  }
}

function readmeText(manifest: ExportManifest): string {
  return `Scrapyard database export
=========================

Exported at : ${manifest.exportedAt}
Exported by : ${manifest.exportedBy}
Database    : ${manifest.database}
Timezone    : ${manifest.timezone}

Contents
--------
database/users.json    one document per racer, _id = the Google 'sub' claim
database/wins.json     one immutable document per win — THE SOURCE OF TRUTH
database/content.json  editable site content (banner puns)
manifest.json          counts and byte sizes for this export

There are no scoreboard files. Leaderboards are aggregations over wins computed
on read, so there is no derived state to back up or restore.

Restoring
---------
  mongoimport --uri "$MONGODB_URI" --collection users   --file database/users.json   --jsonArray
  mongoimport --uri "$MONGODB_URI" --collection wins    --file database/wins.json    --jsonArray
  mongoimport --uri "$MONGODB_URI" --collection content --file database/content.json --jsonArray

Add --drop to replace collections rather than merge into them. Note that
'wins.at' is a BSON date; mongoimport understands the $date form in this dump.
`;
}
