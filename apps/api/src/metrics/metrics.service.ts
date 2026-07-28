import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MongoService, MetricDoc } from '../database/mongo.service';
import type { MetricAggregation, MetricColumn, MetricDef } from '@scrapyard/shared';
import {
  BUILT_IN_METRICS,
  BUILT_IN_METRIC_IDS,
  NON_ADDITIVE_METRICS,
} from './metrics.constants';

const AGGREGATIONS: MetricAggregation[] = ['sum', 'max', 'avg', 'last'];

/** The full registry resolved once and threaded through a request. */
export interface MetricRegistry {
  all: MetricDef[];
  enabled: MetricDef[];
  byId: Map<string, MetricDef>;
  /** Enabled captured metrics — the ones stored on `results.stats`. */
  captured: MetricDef[];
  /** Enabled formula metrics — combinations computed from period totals. */
  formulas: MetricDef[];
}

/**
 * The metric registry: built-in derived metrics (code) plus admin-defined
 * captured and formula metrics (the `metrics` collection). This is the single
 * place that knows the whole vocabulary, so the board roll-up, the achievement
 * evaluator and the admin editor all agree on what a metric is.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly mongo: MongoService) {}

  private toDef(doc: MetricDoc): MetricDef {
    return {
      id: doc._id,
      label: doc.label,
      icon: doc.icon,
      unit: doc.unit,
      description: doc.description,
      kind: doc.kind,
      aggregation: doc.aggregation,
      formula: doc.formula,
      order: doc.order,
      enabled: doc.enabled,
      builtin: false,
    };
  }

  /** Every metric, built-ins first, then admin metrics by their order. */
  async definitions(): Promise<MetricDef[]> {
    const metrics = await this.mongo.metrics();
    const docs = await metrics.find({}).sort({ order: 1 }).toArray();
    return [...BUILT_IN_METRICS, ...docs.map((doc) => this.toDef(doc))].sort(
      (a, b) => a.order - b.order,
    );
  }

  /** Resolve the registry once per request. */
  async registry(): Promise<MetricRegistry> {
    const all = await this.definitions();
    const enabled = all.filter((m) => m.enabled);
    return {
      all,
      enabled,
      byId: new Map(all.map((m) => [m.id, m])),
      captured: enabled.filter((m) => m.kind === 'captured'),
      formulas: enabled.filter((m) => m.kind === 'formula'),
    };
  }

  /** Render contract for a leaderboard header, in display order. */
  columns(defs: MetricDef[]): MetricColumn[] {
    return defs
      .filter((m) => m.enabled)
      .map((m) => ({ id: m.id, label: m.label, icon: m.icon, unit: m.unit, kind: m.kind }));
  }

  /**
   * Apply formula metrics on top of a racer's base (derived + captured) period
   * totals. Formulas are linear weighted sums, so this works identically for a
   * whole-period total or a single race's values.
   */
  computeFormulas(baseTotals: Record<string, number>, formulas: MetricDef[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const metric of formulas) {
      let value = 0;
      for (const term of metric.formula ?? []) {
        value += (baseTotals[term.metricId] ?? 0) * term.weight;
      }
      out[metric.id] = value;
    }
    return out;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  private assertSlug(id: string): string {
    const slug = id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) {
      throw new BadRequestException('Metric id must be 2–31 chars: a letter then letters/digits/_');
    }
    if (BUILT_IN_METRIC_IDS.has(slug)) {
      throw new BadRequestException(`'${slug}' is a built-in metric`);
    }
    return slug;
  }

  private async nextOrder(kind: 'captured' | 'formula'): Promise<number> {
    // Captured metrics live in 100+, formulas in 200+, so they sort after the
    // built-in derived metrics and group together.
    const base = kind === 'captured' ? 100 : 200;
    const metrics = await this.mongo.metrics();
    const docs = await metrics.find({ kind }).sort({ order: -1 }).limit(1).toArray();
    return docs.length ? docs[0].order + 1 : base;
  }

  private validateAggregation(value: string | undefined): MetricAggregation {
    if (value && !AGGREGATIONS.includes(value as MetricAggregation)) {
      throw new BadRequestException(`Aggregation must be one of ${AGGREGATIONS.join(', ')}`);
    }
    return (value as MetricAggregation) ?? 'sum';
  }

  private async validateFormula(
    terms: Array<{ metricId: string; weight: number }> | undefined,
    selfId: string,
  ): Promise<Array<{ metricId: string; weight: number }>> {
    if (!terms || terms.length === 0) {
      throw new BadRequestException('A formula needs at least one term');
    }
    const known = new Map((await this.definitions()).map((m) => [m.id, m]));
    const clean: Array<{ metricId: string; weight: number }> = [];
    for (const term of terms) {
      const ref = known.get(term.metricId);
      if (!ref) throw new BadRequestException(`Unknown metric '${term.metricId}'`);
      if (ref.kind === 'formula') {
        throw new BadRequestException('A formula can only reference derived or captured metrics');
      }
      if (ref.id === selfId) throw new BadRequestException('A formula cannot reference itself');
      if (!Number.isFinite(term.weight)) throw new BadRequestException('Weights must be numbers');
      clean.push({ metricId: term.metricId, weight: term.weight });
    }
    return clean;
  }

  async createMetric(input: {
    id: string;
    label: string;
    kind: 'captured' | 'formula';
    icon?: string;
    unit?: string;
    description?: string;
    aggregation?: string;
    formula?: Array<{ metricId: string; weight: number }>;
  }): Promise<MetricDef> {
    const id = this.assertSlug(input.id);
    const label = input.label?.trim();
    if (!label || label.length > 40) throw new BadRequestException('Label must be 1–40 characters');
    if (input.kind !== 'captured' && input.kind !== 'formula') {
      throw new BadRequestException("Metric kind must be 'captured' or 'formula'");
    }

    const now = new Date().toISOString();
    const doc: MetricDoc = {
      _id: id,
      label,
      icon: (input.icon || 'activity').trim(),
      unit: input.unit?.trim() || undefined,
      description: input.description?.trim() || undefined,
      kind: input.kind,
      aggregation: input.kind === 'formula' ? 'sum' : this.validateAggregation(input.aggregation),
      formula: input.kind === 'formula' ? await this.validateFormula(input.formula, id) : undefined,
      order: await this.nextOrder(input.kind),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    const metrics = await this.mongo.metrics();
    try {
      await metrics.insertOne(doc);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException(`A metric with id '${id}' already exists`);
      }
      throw error;
    }
    return this.toDef(doc);
  }

  async updateMetric(
    id: string,
    patch: {
      label?: string;
      icon?: string;
      unit?: string;
      description?: string;
      aggregation?: string;
      formula?: Array<{ metricId: string; weight: number }>;
      enabled?: boolean;
      order?: number;
    },
  ): Promise<MetricDef> {
    if (BUILT_IN_METRIC_IDS.has(id)) {
      throw new BadRequestException('Built-in metrics cannot be edited');
    }
    const metrics = await this.mongo.metrics();
    const existing = await metrics.findOne({ _id: id });
    if (!existing) throw new NotFoundException(`No metric '${id}'`);

    const set: Partial<MetricDoc> = { updatedAt: new Date().toISOString() };
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label || label.length > 40) throw new BadRequestException('Label must be 1–40 characters');
      set.label = label;
    }
    if (patch.icon !== undefined) set.icon = patch.icon.trim() || 'activity';
    if (patch.unit !== undefined) set.unit = patch.unit.trim() || undefined;
    if (patch.description !== undefined) set.description = patch.description.trim() || undefined;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.order !== undefined) set.order = patch.order;
    if (patch.aggregation !== undefined && existing.kind === 'captured') {
      set.aggregation = this.validateAggregation(patch.aggregation);
    }
    if (patch.formula !== undefined && existing.kind === 'formula') {
      set.formula = await this.validateFormula(patch.formula, id);
    }

    await metrics.updateOne({ _id: id }, { $set: set });
    const updated = await metrics.findOne({ _id: id });
    return this.toDef(updated!);
  }

  async deleteMetric(id: string): Promise<void> {
    if (BUILT_IN_METRIC_IDS.has(id)) {
      throw new BadRequestException('Built-in metrics cannot be deleted');
    }
    const metrics = await this.mongo.metrics();
    const result = await metrics.deleteOne({ _id: id });
    if (result.deletedCount === 0) throw new NotFoundException(`No metric '${id}'`);
  }
}
