import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService, AchievementRuleDoc } from '../database/mongo.service';
import { MetricsService } from '../metrics/metrics.service';
import type { AchievementRule, AchievementScope, AchievementTier } from '@scrapyard/shared';

const SCOPES: AchievementScope[] = ['all-time', 'monthly', 'daily', 'game'];
const TIERS: AchievementTier[] = ['bronze', 'silver', 'gold', 'plasma'];

/**
 * CRUD for admin-defined achievement rules — the data-driven half of the badge
 * system. A rule is a metric threshold within a scope; the AchievementsService
 * evaluates it against a racer's metric totals. The coded specials (happy hour,
 * back-to-back, streaks, comeback) are not rules and live in code.
 */
@Injectable()
export class AchievementRulesService {
  constructor(
    private readonly mongo: MongoService,
    private readonly metrics: MetricsService,
  ) {}

  private toRule(doc: AchievementRuleDoc): AchievementRule {
    return {
      id: doc._id,
      name: doc.name,
      description: doc.description,
      tier: doc.tier,
      icon: doc.icon,
      metricId: doc.metricId,
      scope: doc.scope,
      threshold: doc.threshold,
      order: doc.order,
      enabled: doc.enabled,
    };
  }

  async rules(): Promise<AchievementRule[]> {
    const rules = await this.mongo.achievementRules();
    const docs = await rules.find({}).sort({ order: 1 }).toArray();
    return docs.map((doc) => this.toRule(doc));
  }

  async enabledRules(): Promise<AchievementRule[]> {
    return (await this.rules()).filter((rule) => rule.enabled);
  }

  private async validateMetric(metricId: string): Promise<void> {
    const known = new Set((await this.metrics.definitions()).map((m) => m.id));
    if (!known.has(metricId)) throw new BadRequestException(`Unknown metric '${metricId}'`);
  }

  private validateScope(scope: string): AchievementScope {
    if (!SCOPES.includes(scope as AchievementScope)) {
      throw new BadRequestException(`Scope must be one of ${SCOPES.join(', ')}`);
    }
    return scope as AchievementScope;
  }

  private validateTier(tier: string): AchievementTier {
    if (!TIERS.includes(tier as AchievementTier)) {
      throw new BadRequestException(`Tier must be one of ${TIERS.join(', ')}`);
    }
    return tier as AchievementTier;
  }

  private async nextOrder(): Promise<number> {
    const rules = await this.mongo.achievementRules();
    const docs = await rules.find({}).sort({ order: -1 }).limit(1).toArray();
    return docs.length ? docs[0].order + 1 : 300;
  }

  async createRule(input: {
    name: string;
    description?: string;
    tier?: string;
    icon?: string;
    metricId: string;
    scope: string;
    threshold: number;
  }): Promise<AchievementRule> {
    const name = input.name?.trim();
    if (!name || name.length > 40) throw new BadRequestException('Name must be 1–40 characters');
    if (!Number.isFinite(input.threshold) || input.threshold <= 0) {
      throw new BadRequestException('Threshold must be a positive number');
    }
    await this.validateMetric(input.metricId);

    const now = new Date().toISOString();
    const doc: AchievementRuleDoc = {
      _id: `rule-${randomUUID().slice(0, 8)}`,
      name,
      description: input.description?.trim() || `Reach ${input.threshold} ${input.metricId}.`,
      tier: this.validateTier(input.tier ?? 'bronze'),
      icon: (input.icon || 'award').trim(),
      metricId: input.metricId,
      scope: this.validateScope(input.scope),
      threshold: input.threshold,
      order: await this.nextOrder(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    const rules = await this.mongo.achievementRules();
    try {
      await rules.insertOne(doc);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException('That rule id already exists');
      }
      throw error;
    }
    return this.toRule(doc);
  }

  async updateRule(
    id: string,
    patch: {
      name?: string;
      description?: string;
      tier?: string;
      icon?: string;
      metricId?: string;
      scope?: string;
      threshold?: number;
      enabled?: boolean;
      order?: number;
    },
  ): Promise<AchievementRule> {
    const rules = await this.mongo.achievementRules();
    const existing = await rules.findOne({ _id: id });
    if (!existing) throw new NotFoundException(`No rule '${id}'`);

    const set: Partial<AchievementRuleDoc> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 40) throw new BadRequestException('Name must be 1–40 characters');
      set.name = name;
    }
    if (patch.description !== undefined) set.description = patch.description.trim();
    if (patch.tier !== undefined) set.tier = this.validateTier(patch.tier);
    if (patch.icon !== undefined) set.icon = patch.icon.trim() || 'award';
    if (patch.metricId !== undefined) {
      await this.validateMetric(patch.metricId);
      set.metricId = patch.metricId;
    }
    if (patch.scope !== undefined) set.scope = this.validateScope(patch.scope);
    if (patch.threshold !== undefined) {
      if (!Number.isFinite(patch.threshold) || patch.threshold <= 0) {
        throw new BadRequestException('Threshold must be a positive number');
      }
      set.threshold = patch.threshold;
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.order !== undefined) set.order = patch.order;

    await rules.updateOne({ _id: id }, { $set: set });
    const updated = await rules.findOne({ _id: id });
    return this.toRule(updated!);
  }

  async deleteRule(id: string): Promise<void> {
    const rules = await this.mongo.achievementRules();
    const result = await rules.deleteOne({ _id: id });
    if (result.deletedCount === 0) throw new NotFoundException(`No rule '${id}'`);
  }
}
