import { Injectable } from '@nestjs/common';
import { JsonStoreService } from './json-store.service';
import type { IndexFile, PunsFile, ScoreboardFile, UserRecord } from '@scrapyard/shared';
import { periodKindOf, scoreboardSlug } from '../common/period.util';

const INDEX_PATH = 'index/index.json';

/**
 * The `index` directory holds a single pointer file. Nothing reads data
 * *through* it — it exists so a client (or a human with `cat`) can discover
 * every file in the database in one request, which is how the web app decides
 * what to fetch on boot.
 *
 * It is fully derived, so `rebuild()` is always safe to run.
 */
@Injectable()
export class IndexService {
  constructor(private readonly store: JsonStoreService) {}

  async read(): Promise<IndexFile> {
    const existing = await this.store.read<IndexFile>(INDEX_PATH);
    return existing ?? this.emptyIndex();
  }

  /** Walk every directory and regenerate the pointer file from scratch. */
  async rebuild(): Promise<IndexFile> {
    const users = await this.store.readAll<UserRecord>('users');
    const boards = await this.store.readAll<ScoreboardFile>('scores');
    const content = await this.store.readAll<PunsFile>('content');

    const index: IndexFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      counts: {
        users: users.length,
        scoreboards: boards.length,
        content: content.length,
      },
      users: users
        .map((user) => ({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          file: `users/${user.id}.json`,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      scoreboards: boards
        .map((board) => {
          // Normalise once and derive the filename from the *normalised* kind,
          // so a hand-edited board file missing `kind` can't produce a
          // `scores/undefined-2026-07-01.json` pointer to nothing.
          const kind = board.kind ?? periodKindOf(board.key) ?? 'all-time';
          return {
            kind,
            key: board.key,
            entryCount: board.entries.length,
            file: `scores/${scoreboardSlug(kind, board.key)}.json`,
          };
        })
        .sort((a, b) => a.file.localeCompare(b.file)),
      content: content.map((file) => ({
        id: file.id,
        label: file.label,
        itemCount: file.items.length,
        file: `content/${file.id}.json`,
      })),
    };

    await this.store.write(INDEX_PATH, index);
    return index;
  }

  private emptyIndex(): IndexFile {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      counts: { users: 0, scoreboards: 0, content: 0 },
      users: [],
      scoreboards: [],
      content: [],
    };
  }
}
