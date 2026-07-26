import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * The whole database. Deliberately lo-fi: plain JSON files on disk.
 *
 *   database/
 *     users/<userId>.json        one file per racer, holds every period's score
 *     scores/<slug>.json         one file per leaderboard period, derived
 *     content/<id>.json          editable site content (puns)
 *     index/index.json           pointers to all of the above
 *
 * Two properties we care about:
 *  1. Writes are atomic — we write a temp file *in the target directory* and
 *     rename over the target, so a crash mid-write can never leave a
 *     half-written (unparseable) JSON file.
 *  2. Writes are serialised — a single in-process promise chain acts as a
 *     mutex, so the score-award cascade (user file + 3 scoreboards + index)
 *     can't interleave with another request's cascade.
 */
@Injectable()
export class JsonStoreService {
  private readonly logger = new Logger(JsonStoreService.name);
  private readonly root: string;

  /** The mutex: every mutation appends itself to this chain. */
  private lock: Promise<unknown> = Promise.resolve();

  /**
   * Detects a *nested* transaction(), which would deadlock forever: the inner
   * call would queue behind a chain the outer call is still occupying.
   *
   * This has to be async-context-scoped, not a plain boolean — a boolean would
   * also fire for merely *concurrent* calls from two different requests, which
   * are legitimate and must simply queue. AsyncLocalStorage propagates through
   * the await chain of one transaction only, so it distinguishes "called from
   * inside a transaction" from "called while another is running".
   */
  private readonly context = new AsyncLocalStorage<true>();

  constructor() {
    // path.resolve normalises away a trailing slash, which would otherwise
    // make the containment check below reject every path.
    this.root = path.resolve(
      process.env.DATABASE_DIR ?? path.join(__dirname, '..', '..', 'database'),
    );
  }

  get rootDir(): string {
    return this.root;
  }

  /** Create the directory skeleton. Safe to call repeatedly. */
  async ensureLayout(): Promise<void> {
    for (const dir of ['users', 'scores', 'content', 'index']) {
      await fs.mkdir(path.join(this.root, dir), { recursive: true });
    }
    this.logger.log(`Database root: ${this.root}`);
  }

  private resolve(relativePath: string): string {
    const full = path.resolve(this.root, relativePath);
    // Guard against `../` escaping the database root via a crafted id.
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to touch path outside database root: ${relativePath}`);
    }
    return full;
  }

  async read<T>(relativePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.resolve(relativePath), 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      const names = await fs.readdir(this.resolve(dir));
      return names.filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readAll<T>(dir: string): Promise<T[]> {
    const files = await this.list(dir);
    const out: T[] = [];
    for (const file of files) {
      const value = await this.read<T>(path.join(dir, file));
      if (value) out.push(value);
    }
    return out;
  }

  /**
   * Atomic write. The temp file is created in the *same directory* as the
   * target — not os.tmpdir() — because rename is only atomic within a single
   * filesystem. With DATABASE_DIR pointing at a mounted volume, a temp file in
   * /tmp would land on another device and force a copy, which truncates the
   * destination first and reintroduces exactly the torn-write risk we're
   * trying to eliminate.
   */
  async write(relativePath: string, value: unknown): Promise<void> {
    const target = this.resolve(relativePath);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });

    const temp = path.join(
      dir,
      `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`,
    );

    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await fs.writeFile(temp, body, 'utf8');
      await fs.rename(temp, target);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async remove(relativePath: string): Promise<void> {
    await fs.unlink(this.resolve(relativePath)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Absolute path for a relative entry — used by the zip export. */
  absolute(relativePath: string): string {
    return this.resolve(relativePath);
  }

  /**
   * Run `fn` with exclusive access to the database. Every write path in the
   * app goes through here, which is what makes the multi-file score cascade
   * safe without pulling in a real database.
   *
   * Not reentrant — see `inTransaction` above. Helpers meant to be called from
   * inside a transaction (ScoreboardBuilder, IndexService) deliberately call
   * `write()` directly rather than opening their own.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) {
      throw new Error(
        'Nested JsonStoreService.transaction() detected — this would deadlock. ' +
          'Call store.write() directly from inside a transaction instead.',
      );
    }

    const guarded = (): Promise<T> => this.context.run(true, fn);

    const run = this.lock.then(guarded, guarded);
    // Keep the chain alive even if this transaction rejects.
    this.lock = run.catch(() => undefined);
    return run;
  }
}
