/**
 * ============================================================
 * Quota — Logging + Analytics Service
 * ============================================================
 * PURPOSE: Tracks every request through the Quota pipeline.
 * Stores usage records for analytics, cost reporting, and
 * savings calculations.
 *
 * STORAGE: In-memory with periodic flush. Production should
 * pipe to a time-series DB (InfluxDB, TimescaleDB, etc.)
 * or export to a data warehouse.
 *
 * ANALYTICS: Computes per-key and global usage summaries
 * including savings from caching and optimization.
 * ============================================================
 */

import { UsageRecord, UsageSummary, RequestContext } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('analytics');

/** Maximum records to keep in memory before eviction. */
const MAX_RECORDS = 100_000;

export class AnalyticsService {
  private records: UsageRecord[] = [];
  /** Quick lookup: apiKey → records for that key. */
  private byApiKey = new Map<string, UsageRecord[]>();

  /**
   * Record a completed request's metrics.
   * Called at the end of every pipeline execution.
   */
  record(ctx: RequestContext): void {
    const record: UsageRecord = {
      requestId: ctx.id,
      apiKey: ctx.original.apiKey,
      timestamp: ctx.timestamp,
      model: ctx.routedModel!,
      inputTokens: ctx.response?.inputTokens || ctx.estimated?.inputTokens || 0,
      outputTokens: ctx.response?.outputTokens || ctx.estimated?.estimatedOutputTokens || 0,
      estimatedCostUsd: ctx.estimated?.totalEstimatedCostUsd || 0,
      actualCostUsd: ctx.cached ? 0 : (ctx.response?.actualCostUsd || 0),
      savingsUsd: this.calculateSavings(ctx),
      cached: ctx.cached,
      optimizations: ctx.optimized?.optimizations || [],
      latencyMs: ctx.totalLatencyMs,
    };

    this.records.push(record);

    // Index by API key
    const keyRecords = this.byApiKey.get(record.apiKey) || [];
    keyRecords.push(record);
    this.byApiKey.set(record.apiKey, keyRecords);

    // Evict oldest records if over limit
    if (this.records.length > MAX_RECORDS) {
      const evicted = this.records.splice(0, this.records.length - MAX_RECORDS);
      log.info({ evicted: evicted.length }, 'Evicted old analytics records');
    }

    log.debug({
      requestId: record.requestId,
      cost: record.actualCostUsd,
      savings: record.savingsUsd,
    }, 'Usage recorded');
  }

  /**
   * Get usage summary for a specific API key over a time period.
   *
   * @param apiKey - The API key to summarize
   * @param sinceMs - Start timestamp (default: 24h ago)
   */
  getSummary(apiKey: string, sinceMs?: number): UsageSummary {
    const since = sinceMs || Date.now() - 24 * 60 * 60 * 1000;
    const keyRecords = (this.byApiKey.get(apiKey) || [])
      .filter(r => r.timestamp >= since);

    const modelBreakdown: Record<string, number> = {};
    let cacheHits = 0;

    for (const r of keyRecords) {
      modelBreakdown[r.model] = (modelBreakdown[r.model] || 0) + 1;
      if (r.cached) cacheHits++;
    }

    return {
      apiKey,
      period: `since ${new Date(since).toISOString()}`,
      totalRequests: keyRecords.length,
      totalInputTokens: keyRecords.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: keyRecords.reduce((s, r) => s + r.outputTokens, 0),
      totalCostUsd: parseFloat(keyRecords.reduce((s, r) => s + r.actualCostUsd, 0).toFixed(6)),
      totalSavingsUsd: parseFloat(keyRecords.reduce((s, r) => s + r.savingsUsd, 0).toFixed(6)),
      cacheHitRate: keyRecords.length > 0 ? cacheHits / keyRecords.length : 0,
      modelBreakdown,
    };
  }

  /** Get global usage summary across all API keys. */
  getGlobalSummary(sinceMs?: number): Omit<UsageSummary, 'apiKey'> & { uniqueKeys: number } {
    const since = sinceMs || Date.now() - 24 * 60 * 60 * 1000;
    const filtered = this.records.filter(r => r.timestamp >= since);
    const uniqueKeys = new Set(filtered.map(r => r.apiKey)).size;
    const modelBreakdown: Record<string, number> = {};
    let cacheHits = 0;

    for (const r of filtered) {
      modelBreakdown[r.model] = (modelBreakdown[r.model] || 0) + 1;
      if (r.cached) cacheHits++;
    }

    return {
      uniqueKeys,
      period: `since ${new Date(since).toISOString()}`,
      totalRequests: filtered.length,
      totalInputTokens: filtered.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: filtered.reduce((s, r) => s + r.outputTokens, 0),
      totalCostUsd: parseFloat(filtered.reduce((s, r) => s + r.actualCostUsd, 0).toFixed(6)),
      totalSavingsUsd: parseFloat(filtered.reduce((s, r) => s + r.savingsUsd, 0).toFixed(6)),
      cacheHitRate: filtered.length > 0 ? cacheHits / filtered.length : 0,
      modelBreakdown,
    };
  }

  /** Get recent records (for debugging / admin UI). */
  getRecent(limit: number = 50): UsageRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * Calculate total savings from all Quota optimizations:
   *   1. Cache hits: full cost avoided
   *   2. Model routing: difference between requested and routed model cost
   *   3. Token optimization: tokens saved × model rate
   */
  private calculateSavings(ctx: RequestContext): number {
    let savings = 0;

    // Cache hit = entire estimated cost saved
    if (ctx.cached && ctx.estimated) {
      return ctx.estimated.totalEstimatedCostUsd;
    }

    // Model routing savings: if routed to cheaper model
    if (ctx.estimated && ctx.routedModel && ctx.estimated.model !== ctx.routedModel) {
      const originalCost = ctx.estimated.alternativeModels[ctx.estimated.model] || 0;
      const routedCost = ctx.estimated.alternativeModels[ctx.routedModel] || 0;
      savings += Math.max(0, originalCost - routedCost);
    }

    // Token optimization savings
    if (ctx.optimized && ctx.optimized.tokensSaved > 0 && ctx.routedModel) {
      // Approximate savings based on input token rate
      const rate = ctx.estimated?.inputCostUsd
        ? ctx.estimated.inputCostUsd / ctx.estimated.inputTokens
        : 0;
      savings += ctx.optimized.tokensSaved * rate;
    }

    return parseFloat(savings.toFixed(6));
  }
}
