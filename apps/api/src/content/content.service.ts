import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JsonStoreService } from '../database/json-store.service';
import { IndexService } from '../database/index.service';
import type { Pun, PunsFile } from '@scrapyard/shared';

const PUNS_PATH = 'content/puns.json';

/**
 * Everything the admin page can edit lives here. Today that's one content
 * type — the banner puns — but the shape is a registry so adding the next
 * type is a matter of appending to CONTENT_TYPES and giving it a file.
 */
export interface ContentTypeDescriptor {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** Search terms the admin grid matches against. */
  keywords: string[];
  editable: boolean;
  itemCount: number;
  /**
   * 'content' cards open an editor. 'action' cards fire a one-shot operation
   * (currently just the database export) — the grid renders them differently
   * so it's obvious which cards do something immediately.
   */
  kind: 'content' | 'action';
  /** Unit shown next to itemCount, e.g. "puns", "files". */
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
export class ContentService implements OnModuleInit {
  constructor(
    private readonly store: JsonStoreService,
    private readonly index: IndexService,
  ) {}

  /** Seed the puns file on first boot so the banner is never empty. */
  async onModuleInit(): Promise<void> {
    await this.store.ensureLayout();
    const existing = await this.store.read<PunsFile>(PUNS_PATH);
    if (existing) return;

    const now = new Date().toISOString();
    const file: PunsFile = {
      id: 'puns',
      label: 'Banner Puns',
      updatedAt: now,
      items: DEFAULT_PUNS.map((text) => ({
        id: randomUUID(),
        text,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })),
    };
    await this.store.write(PUNS_PATH, file);
    await this.index.rebuild();
  }

  async readPunsFile(): Promise<PunsFile> {
    const file = await this.store.read<PunsFile>(PUNS_PATH);
    if (file) return file;
    await this.onModuleInit();
    return (await this.store.read<PunsFile>(PUNS_PATH))!;
  }

  /** Public banner feed — enabled puns only. */
  async listEnabledPuns(): Promise<Pun[]> {
    const file = await this.readPunsFile();
    return file.items.filter((pun) => pun.enabled);
  }

  /** Admin view — everything, including disabled. */
  async listAllPuns(): Promise<Pun[]> {
    return (await this.readPunsFile()).items;
  }

  async createPun(text: string): Promise<Pun> {
    return this.store.transaction(async () => {
      const clean = this.validateText(text);
      const file = await this.readPunsFile();
      const now = new Date().toISOString();
      const pun: Pun = { id: randomUUID(), text: clean, enabled: true, createdAt: now, updatedAt: now };
      await this.save({ ...file, items: [...file.items, pun] });
      return pun;
    });
  }

  async updatePun(id: string, patch: { text?: string; enabled?: boolean }): Promise<Pun> {
    return this.store.transaction(async () => {
      const file = await this.readPunsFile();
      const position = file.items.findIndex((pun) => pun.id === id);
      if (position === -1) throw new NotFoundException('No such pun');

      const next: Pun = {
        ...file.items[position],
        ...(patch.text !== undefined ? { text: this.validateText(patch.text) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: new Date().toISOString(),
      };

      const items = [...file.items];
      items[position] = next;
      await this.save({ ...file, items });
      return next;
    });
  }

  async deletePun(id: string): Promise<void> {
    await this.store.transaction(async () => {
      const file = await this.readPunsFile();
      const items = file.items.filter((pun) => pun.id !== id);
      if (items.length === file.items.length) throw new NotFoundException('No such pun');
      await this.save({ ...file, items });
    });
  }

  /** Persist a full reorder from the admin drag handles. */
  async reorderPuns(orderedIds: string[]): Promise<Pun[]> {
    return this.store.transaction(async () => {
      const file = await this.readPunsFile();
      const byId = new Map(file.items.map((pun) => [pun.id, pun]));
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
      await this.save({ ...file, items });
      return items;
    });
  }

  /**
   * Cards for the admin grid. `fileCount` is injected by the controller so this
   * service doesn't need to know about the export machinery.
   */
  async describeTypes(fileCount: number): Promise<ContentTypeDescriptor[]> {
    const puns = await this.readPunsFile();
    return [
      {
        id: 'puns',
        label: 'Banner Puns',
        description: 'The rolling one-liners in the top prompter, between each Arthur flyby.',
        icon: 'megaphone',
        keywords: ['pun', 'puns', 'banner', 'ticker', 'prompter', 'joke', 'jokes', 'marquee', 'headline'],
        editable: true,
        itemCount: puns.items.length,
        kind: 'content',
        unit: 'puns',
      },
      {
        id: 'export',
        label: 'Export Database',
        description: 'Download every JSON file — racers, scoreboards, content and index — as one zip.',
        icon: 'download',
        keywords: [
          'export', 'download', 'backup', 'zip', 'archive', 'dump',
          'json', 'database', 'data', 'snapshot', 'save', 'restore',
        ],
        editable: true,
        itemCount: fileCount,
        kind: 'action',
        unit: 'files',
      },
      {
        id: 'achievements',
        label: 'Achievements',
        description: 'Badge definitions and thresholds. Derived in code — read-only for now.',
        icon: 'trophy',
        keywords: ['achievement', 'achievements', 'badge', 'badges', 'medal', 'trophy', 'streak'],
        editable: false,
        itemCount: 18,
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

  private async save(file: PunsFile): Promise<void> {
    await this.store.write(PUNS_PATH, { ...file, updatedAt: new Date().toISOString() });
    await this.index.rebuild();
  }
}
