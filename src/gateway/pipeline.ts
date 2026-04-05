/**
 * ============================================================
 * Quota — Request Pipeline
 * ============================================================
 * PURPOSE: Orchestrates the full request lifecycle through all
 * Quota components in sequence. This is the core processing
 * engine — every request flows through this pipeline.
 *
 * PIPELINE STAGES:
 *   1. Analyze → understand the request
 *   2. Estimate → calculate cost
 *   3. Cache Check → return early if cached
 *   4. Policy → enforce rules
 *   5. Optimize → reduce tokens
 *   6. Route → select model
 *   7. Execute → call Claude
 *   8. Cache Store → save for future
 *   9. Log → record analytics
 *
 * FAILURE MODES:
 *   - Policy block → returns error, no API call made
 *   - Execution failure → retries in executor, then bubbles up
 *   - Cache miss → proceeds to execution (not a failure)
 * ============================================================
 */

import { v4 as uuidv4 } from 'uuid';
import {
  QuotaRequest,
  RequestContext,
  PolicyAction,
  QuotaApiResponse,
  CostPreviewResponse,
  ClaudeModel,
} from '../types';
import { RequestAnalyzer } from '../analyzer';
import { CostEstimator } from '../estimator';
import { PolicyEngine } from '../policy';
import { OptimizationEngine } from '../optimizer';
import { ModelRouter } from '../router';
import { ExecutionLayer } from '../executor';
import { CacheLayer } from '../cache';
import { AnalyticsService } from '../logging';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('pipeline');

export class RequestPipeline {
  private analyzer: RequestAnalyzer;
  private estimator: CostEstimator;
  private policy: PolicyEngine;
  private optimizer: OptimizationEngine;
  private router: ModelRouter;
  private executor: ExecutionLayer;
  private cache: CacheLayer;
  private analytics: AnalyticsService;

  constructor() {
    this.analyzer = new RequestAnalyzer();
    this.estimator = new CostEstimator();
    this.policy = new PolicyEngine();
    this.optimizer = new OptimizationEngine();
    this.router = new ModelRouter();
    this.executor = new ExecutionLayer();
    this.cache = new CacheLayer();
    this.analytics = new AnalyticsService();
  }

  /**
   * Full pipeline execution: analyze → estimate → cache → policy
   * → optimize → route → execute → cache → log → respond.
   */
  async process(request: QuotaRequest): Promise<QuotaApiResponse> {
    const ctx: RequestContext = {
      id: uuidv4(),
      timestamp: Date.now(),
      original: request,
      analyzed: null,
      estimated: null,
      policyResult: null,
      optimized: null,
      routedModel: null,
      response: null,
      cached: false,
      totalLatencyMs: 0,
    };

    const startMs = Date.now();

    try {
      // Stage 1: Analyze
      ctx.analyzed = this.analyzer.analyze(request);

      // Stage 2: Estimate cost
      ctx.estimated = this.estimator.estimate(
        ctx.analyzed,
        request.model || config.policy.defaultModel
      );

      // Stage 3: Cache check (before policy — cached responses are free)
      const targetModel = request.model || config.policy.defaultModel;
      const cacheKey = this.cache.generateKey(request, targetModel);
      const cachedResult = await this.cache.get(cacheKey);

      if (cachedResult) {
        ctx.cached = true;
        ctx.response = cachedResult;
        ctx.routedModel = cachedResult.model;
        ctx.totalLatencyMs = Date.now() - startMs;
        this.analytics.record(ctx);

        log.info({ requestId: ctx.id, latencyMs: ctx.totalLatencyMs }, 'Cache hit — returning cached response');

        return this.buildResponse(ctx);
      }

      // Stage 4: Policy evaluation
      ctx.policyResult = this.policy.evaluate(request, ctx.analyzed, ctx.estimated);

      if (ctx.policyResult.action === PolicyAction.BLOCK) {
        ctx.totalLatencyMs = Date.now() - startMs;
        this.analytics.record(ctx);

        return {
          success: false,
          error: `Request blocked by policy: ${ctx.policyResult.violations.map(v => v.message).join('; ')}`,
          meta: {
            requestId: ctx.id,
            latencyMs: ctx.totalLatencyMs,
            cached: false,
            estimatedCostUsd: ctx.estimated.totalEstimatedCostUsd,
            actualCostUsd: 0,
            savingsUsd: ctx.estimated.totalEstimatedCostUsd,
            optimizations: [],
            model: targetModel,
          },
        };
      }

      // Apply policy modifications (e.g., reduced max_tokens)
      if (ctx.policyResult.action === PolicyAction.MODIFY) {
        Object.assign(request, ctx.policyResult.modifications);
      }

      // Stage 5: Optimize
      ctx.optimized = this.optimizer.optimize(request, ctx.analyzed);

      // Stage 6: Route model
      ctx.routedModel = this.router.route(
        request.model,
        ctx.analyzed,
        ctx.estimated,
        ctx.policyResult
      );

      // Stage 7: Execute
      ctx.response = await this.executor.execute(
        ctx.optimized,
        ctx.routedModel,
        request.maxTokens || config.policy.maxOutputTokens,
        request.temperature
      );

      // Stage 8: Cache the response
      const finalCacheKey = this.cache.generateKey(request, ctx.routedModel);
      await this.cache.set(finalCacheKey, ctx.response);

      // Record spend for budget tracking
      this.policy.recordSpend(request.apiKey, ctx.response.actualCostUsd);

      // Stage 9: Log analytics
      ctx.totalLatencyMs = Date.now() - startMs;
      this.analytics.record(ctx);

      log.info({
        requestId: ctx.id,
        model: ctx.routedModel,
        cost: ctx.response.actualCostUsd,
        latencyMs: ctx.totalLatencyMs,
      }, 'Pipeline completed');

      return this.buildResponse(ctx);

    } catch (err: any) {
      ctx.totalLatencyMs = Date.now() - startMs;
      log.error({ requestId: ctx.id, error: err.message, stack: err.stack }, 'Pipeline error');

      return {
        success: false,
        error: err.message || 'Internal pipeline error',
        meta: {
          requestId: ctx.id,
          latencyMs: ctx.totalLatencyMs,
          cached: false,
          estimatedCostUsd: ctx.estimated?.totalEstimatedCostUsd || 0,
          actualCostUsd: 0,
          savingsUsd: 0,
          optimizations: ctx.optimized?.optimizations || [],
          model: ctx.routedModel || config.policy.defaultModel,
        },
      };
    }
  }

  /**
   * Preview-only: runs analyze + estimate + policy without executing.
   * Useful for cost estimation before committing to a request.
   */
  async preview(request: QuotaRequest): Promise<CostPreviewResponse> {
    const analyzed = this.analyzer.analyze(request);
    const estimated = this.estimator.estimate(analyzed, request.model);
    const policyResult = this.policy.evaluate(request, analyzed, estimated);

    const recommendedModel = this.router.route(
      undefined, // Don't lock to requested model — show the recommendation
      analyzed,
      estimated,
      policyResult
    );

    return {
      estimatedCostUsd: estimated.totalEstimatedCostUsd,
      inputTokens: estimated.inputTokens,
      estimatedOutputTokens: estimated.estimatedOutputTokens,
      recommendedModel,
      alternativeCosts: Object.fromEntries(
        Object.entries(estimated.alternativeModels).map(([k, v]) => [k, v])
      ),
      policyStatus: policyResult.action,
      violations: policyResult.violations,
    };
  }

  /** Get analytics summary for an API key. */
  getAnalytics(apiKey: string, sinceMs?: number) {
    return this.analytics.getSummary(apiKey, sinceMs);
  }

  /** Get global analytics. */
  getGlobalAnalytics() {
    return this.analytics.getGlobalSummary();
  }

  /** Get recent request log. */
  getRecentRequests(limit?: number) {
    return this.analytics.getRecent(limit);
  }

  /** Get cache statistics. */
  getCacheStats() {
    return this.cache.getStats();
  }

  /** Get budget info for a key. */
  getBudgetInfo(apiKey: string) {
    return {
      spent: this.policy.getSpend(apiKey),
      remaining: this.policy.getBudgetRemaining(apiKey),
      dailyLimit: config.policy.budgetPerKeyDailyUsd,
    };
  }

  /** Clear response cache. */
  async clearCache() {
    await this.cache.clear();
  }

  /** Graceful shutdown. */
  async shutdown() {
    await this.cache.shutdown();
  }

  private buildResponse(ctx: RequestContext): QuotaApiResponse {
    return {
      success: true,
      data: {
        content: ctx.response!.content,
        model: ctx.response!.model,
        stopReason: ctx.response!.stopReason,
        usage: {
          inputTokens: ctx.response!.inputTokens,
          outputTokens: ctx.response!.outputTokens,
        },
      },
      meta: {
        requestId: ctx.id,
        latencyMs: ctx.totalLatencyMs,
        cached: ctx.cached,
        estimatedCostUsd: ctx.estimated?.totalEstimatedCostUsd || 0,
        actualCostUsd: ctx.cached ? 0 : ctx.response!.actualCostUsd,
        savingsUsd: ctx.cached
          ? ctx.estimated?.totalEstimatedCostUsd || 0
          : (ctx.optimized?.tokensSaved || 0) * 0.000003, // approximate
        optimizations: ctx.optimized?.optimizations || [],
        model: ctx.response!.model,
      },
    };
  }
}
