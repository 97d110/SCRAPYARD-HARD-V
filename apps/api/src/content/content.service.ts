import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../database/mongo.service';
import type { Pun, PunsDocument } from '@scrapyard/shared';

const PUNS_ID = 'puns';

/**
 * Everything the admin page can edit. Today that's one content type — the
 * banner puns — but the shape is a registry, so adding the next type means
 * appending to `describeTypes` and giving it a document.
 */
export interface ContentTypeDescriptor {
  id: string;
  label: string;
  description: string;
  icon: string;
  keywords: string[];
  editable: boolean;
  itemCount: number;
  kind: 'content' | 'action';
  unit?: string;
}

/** Shipped defaults — silly puns from the BlazeRush world. */
export const DEFAULT_PUNS: string[] = [
  'No health, no levelling, no brakes — and absolutely no excuses.',
  'I told the Rocket I needed space. It followed me anyway.',
  'Brakes are a rumour started by slow people.',
  'Turboboy skipped his homework, never a boost pad.',
  'Mr. Shnek says winning is 10% skill and 90% not being last.',
  'The saw blade and I have a cutting-edge relationship.',
  "I'd tell you a mine joke, but it might blow up in your face.",
  "Old Rowdy doesn't drift — the planet rotates around him.",
  'Three planets, sixteen cars, zero regrets.',
  'My pit crew is one guy named Dee and a lot of duct tape.',
  'Tailfin calls it aerodynamics. We call it showing off.',
  'Chain lightning: because losing friends should be electrifying.',
  'I came for the racing. I stayed for the explosions.',
  "Predator's headlights are the last thing you see. And the first.",
  'Panzerflachbagger: hard to say, harder to overtake.',
  'The Twins finish first and second. Every. Single. Time.',
  'A UFO abducted my lap record and I want it back.',
  "Arthur doesn't park. Arthur hovers menacingly.",
  'Lava is just the track offering you a warm welcome.',
  "If you're not first, you're being chased by a rocket.",
  'Dipnoi went for a swim. On the ice planet. Once.',
  'Rex has two speeds: full, and on fire.',
];

@Injectable()
export class ContentService {
  constructor(private readonly mongo: MongoService) {}

  /**
   * Read the puns document, seeding the defaults if it doesn't exist.
   *
   * Seeding lives here rather than in `onModuleInit` deliberately: on serverless
   * the module initialises on every cold start, so writing there would add
   * latency to arbitrary requests. `upsert` with `$setOnInsert` also makes two
   * concurrent cold starts safe — the second is a no-op, not a duplicate.
   */
  async readPuns(): Promise<PunsDocument> {
    const content = await this.mongo.content();
    const existing = await content.findOne({ _id: PUNS_ID });
    if (existing) {
      return {
        id: PUNS_ID,
        label: existing.label,
        updatedAt: existing.updatedAt,
        items: existing.items,
      };
    }

    const now = new Date().toISOString();
    const items: Pun[] = DEFAULT_PUNS.map((text) => ({
      id: randomUUID(),
      text,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }));

    await content.updateOne(
      { _id: PUNS_ID },
      { $setOnInsert: { label: 'Banner Puns', updatedAt: now, items } },
      { upsert: true },
    );

    const seeded = await content.findOne({ _id: PUNS_ID });
    return {
      id: PUNS_ID,
      label: seeded?.label ?? 'Banner Puns',
      updatedAt: seeded?.updatedAt ?? now,
      items: seeded?.items ?? items,
    };
  }

  /** Public banner feed — enabled puns only. */
  async listEnabledPuns(): Promise<Pun[]> {
    return (await this.readPuns()).items.filter((pun) => pun.enabled);
  }

  /** Admin view — everything, including disabled. */
  async listAllPuns(): Promise<Pun[]> {
    return (await this.readPuns()).items;
  }

  async createPun(text: string): Promise<Pun> {
    const clean = this.validateText(text);
    await this.readPuns(); // ensure the document exists
    const content = await this.mongo.content();
    const now = new Date().toISOString();
    const pun: Pun = {
      id: randomUUID(),
      text: clean,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    // $push is atomic server-side — no read-modify-write race between admins.
    await content.updateOne({ _id: PUNS_ID }, { $push: { items: pun }, $set: { updatedAt: now } });
    return pun;
  }

  async updatePun(id: string, patch: { text?: string; enabled?: boolean }): Promise<Pun> {
    const content = await this.mongo.content();
    const now = new Date().toISOString();

    // The positional operator updates the matched array element in place.
    const set: Record<string, unknown> = { 'items.$.updatedAt': now, updatedAt: now };
    if (patch.text !== undefined) set['items.$.text'] = this.validateText(patch.text);
    if (patch.enabled !== undefined) set['items.$.enabled'] = patch.enabled;

    const result = await content.updateOne({ _id: PUNS_ID, 'items.id': id }, { $set: set });
    if (result.matchedCount === 0) throw new NotFoundException('No such pun');

    const doc = await this.readPuns();
    const pun = doc.items.find((item) => item.id === id);
    if (!pun) throw new NotFoundException('No such pun');
    return pun;
  }

  async deletePun(id: string): Promise<void> {
    const content = await this.mongo.content();
    const result = await content.updateOne(
      { _id: PUNS_ID },
      { $pull: { items: { id } }, $set: { updatedAt: new Date().toISOString() } },
    );
    if (result.modifiedCount === 0) throw new NotFoundException('No such pun');
  }

  /** Persist a full reorder from the admin drag handles. */
  async reorderPuns(orderedIds: string[]): Promise<Pun[]> {
    const doc = await this.readPuns();
    const byId = new Map(doc.items.map((pun) => [pun.id, pun]));
    const items: Pun[] = [];

    for (const id of orderedIds) {
      const pun = byId.get(id);
      if (pun) {
        items.push(pun);
        byId.delete(id);
      }
    }
    // Anything the client didn't mention keeps its relative order at the end.
    items.push(...byId.values());

    const content = await this.mongo.content();
    await content.updateOne(
      { _id: PUNS_ID },
      { $set: { items, updatedAt: new Date().toISOString() } },
    );
    return items;
  }

  /** Cards for the searchable admin grid. Counts come from the exporter / registries. */
  async describeTypes(
    documentCount: number,
    achievementCount: number,
    metricCount: number,
  ): Promise<ContentTypeDescriptor[]> {
    const puns = await this.readPuns();
    const users = await this.mongo.users();
    const games = await this.mongo.games();
    const [crewCount, unclaimedCount, gameCount] = await Promise.all([
      users.countDocuments(),
      users.countDocuments({ googleId: { $exists: false } }),
      games.countDocuments(),
    ]);
    return [
      {
        id: 'puns',
        label: 'Banner Puns',
        description: 'The rolling one-liners in the top prompter, between each Arthur flyby.',
        icon: 'megaphone',
        keywords: [
          'pun', 'puns', 'banner', 'ticker', 'prompter', 'joke', 'jokes', 'marquee', 'headline',
        ],
        editable: true,
        itemCount: puns.items.length,
        kind: 'content',
        unit: 'puns',
      },
      {
        id: 'export',
        label: 'Export Database',
        description: 'Download every collection — racers, wins and content — as one zip.',
        icon: 'download',
        keywords: [
          'export', 'download', 'backup', 'zip', 'archive', 'dump',
          'json', 'database', 'mongo', 'data', 'snapshot', 'save', 'restore',
        ],
        editable: true,
        itemCount: documentCount,
        kind: 'action',
        unit: 'documents',
      },
      {
        id: 'crew',
        label: 'Crew Roster',
        description:
          unclaimedCount > 0
            ? `Add teammates by email so they can be scored before they sign in. ${unclaimedCount} waiting to be claimed.`
            : 'Add teammates by email so they can be scored before they ever sign in.',
        icon: 'user-plus',
        keywords: [
          'crew', 'team', 'member', 'members', 'user', 'users', 'people', 'add', 'invite',
          'roster', 'email', 'colleague', 'teammate', 'account', 'new',
        ],
        editable: true,
        itemCount: crewCount,
        kind: 'content',
        unit: unclaimedCount > 0 ? `${unclaimedCount} unclaimed` : 'racers',
      },
      {
        id: 'games',
        label: 'Race Log',
        description:
          'Every recorded race, newest first. Delete a bad entry and same-day revenge tags recompute automatically.',
        icon: 'flag',
        keywords: [
          'game', 'games', 'race', 'races', 'log', 'history', 'delete', 'undo',
          'kills', 'revenge', 'results',
        ],
        editable: true,
        itemCount: gameCount,
        kind: 'content',
        unit: 'races',
      },
      {
        id: 'metrics',
        label: 'Metrics & Scoring',
        description:
          'Captured stats (kills, …) and formula scoring systems (Combat = 2·kills − deaths). Sortable columns on every board.',
        icon: 'sliders-horizontal',
        keywords: [
          'metric', 'metrics', 'stat', 'stats', 'score', 'scoring', 'formula', 'kills',
          'points', 'column', 'sort', 'system',
        ],
        editable: true,
        itemCount: metricCount,
        kind: 'content',
        unit: 'metrics',
      },
      {
        id: 'achievements',
        label: 'Achievements',
        description:
          'Badge rules over any metric — threshold × scope (all-time, day, month, single race). Plus a few coded specials.',
        icon: 'trophy',
        keywords: ['achievement', 'achievements', 'badge', 'badges', 'medal', 'trophy', 'streak', 'rule', 'rules'],
        editable: true,
        itemCount: achievementCount,
        kind: 'content',
        unit: 'badges',
      },
      {
        id: 'racers',
        label: 'Racer Roster',
        description: 'The BlazeRush pilots available as a profile flavour pick. Read-only for now.',
        icon: 'users',
        keywords: ['racer', 'racers', 'roster', 'pilot', 'pilots', 'car', 'cars', 'character'],
        editable: false,
        itemCount: 17,
        kind: 'content',
        unit: 'pilots',
      },
      {
        id: 'theme',
        label: 'Theme & Accents',
        description: 'Neon palette and glow intensity. Compiled into the client — read-only for now.',
        icon: 'palette',
        keywords: ['theme', 'colour', 'color', 'palette', 'neon', 'accent', 'glow', 'design'],
        editable: false,
        itemCount: 8,
        kind: 'content',
        unit: 'colours',
      },
    ];
  }

  private validateText(value: string): string {
    const text = value.trim().replace(/\s+/g, ' ');
    if (text.length < 3) throw new BadRequestException('A pun needs at least 3 characters');
    if (text.length > 160) throw new BadRequestException('Keep puns under 160 characters');
    return text;
  }
}
