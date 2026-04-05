/**
 * ============================================================
 * Quota — Policy Engine
 * ============================================================
 * PURPOSE: Enforces cost, token, and model policies on every
 * request. Can ALLOW, MODIFY, or BLOCK requests based on
 * configurable rules and real-time budget tracking.
 *
 * RULES EVALUATED (in order):
 *   1. Token limit per request
 *   2. Model restrictions
 *   3. Daily budget per API key
 *   4. Output token cap
 *
 * BUDGET TRACKING: In-memory per-key daily spend. Resets at
 * midnight UTC. Production should use Redis for persistence.
 *
 * DATA FLOW: Estimator → Policy → (allow/modify/block)
 * ============================================================
 */

import {
  CostEstimate,
  AnalysisResult,
  PolicyResult,
  PolicyAction,
  PolicyViolation,
  PolicyConfig,
  ClaudeModel,
  QuotaRequest,
} from '../types';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('policy');

/** Per-key daily spend tracker. Key format: "apiKey:YYYY-MM-DD" */
const dailySpend = new Map<string, number>();

export class PolicyEngine {
  private config: PolicyConfig;

  constructor(policyConfig?: Partial<PolicyConfig>) {
    this.config = {
      maxTokensPerRequest: policyConfig?.maxTokensPerRequest || config.policy.maxTokensPerRequest,
      maxOutputTokens: policyConfig?.maxOutputTokens || config.policy.maxOutputTokens,
      budgetPerKeyDailyUsd: policyConfig?.budgetPerKeyDailyUsd || config.policy.budgetPerKeyDailyUsd,
      allowedModels: policyConfig?.allowedModels || Object.values(ClaudeModel),
      blockOnBudgetExceeded: policyConfig?.blockOnBudgetExceeded ?? true,
    };
  }

  /**
   * Evaluate all policies against the request.
   * Returns the action to take and any modifications needed.
   */
  evaluate(
    request: QuotaRequest,
    analysis: AnalysisResult,
    estimate: CostEstimate
  ): PolicyResult {
    const violations: PolicyViolation[] = [];
    const modifications: Partial<QuotaRequest> = {};
    let action = PolicyAction.ALLOW;

    // Rule 1: Token limit per request
    if (analysis.totalInputTokens > this.config.maxTokensPerRequest) {
      violations.push({
        rule: 'max_tokens_per_request',
        message: `Input tokens (${analysis.totalInputTokens}) exceed limit (${this.config.maxTokensPerRequest})`,
        severity: 'error',
      });
      action = PolicyAction.BLOCK;
    }

    // Rule 2: Output token cap
    if (request.maxTokens && request.maxTokens > this.config.maxOutputTokens) {
      violations.push({
        rule: 'max_output_tokens',
        message: `Requested max_tokens (${request.maxTokens}) exceeds cap (${this.config.maxOutputTokens}). Will be reduced.`,
        severity: 'warning',
      });
      modifications.maxTokens = this.config.maxOutputTokens;
      if (action !== PolicyAction.BLOCK) action = PolicyAction.MODIFY;
    }

    // Rule 3: Model restrictions
    const requestedModel = request.model || config.policy.defaultModel;
    if (!this.config.allowedModels.includes(requestedModel)) {
      violations.push({
        rule: 'model_restriction',
        message: `Model ${requestedModel} is not allowed. Allowed: ${this.config.allowedModels.join(', ')}`,
        severity: 'error',
      });
      action = PolicyAction.BLOCK;
    }

    // Rule 4: Daily budget per API key
    const budgetKey = this.getBudgetKey(request.apiKey);
    const currentSpend = dailySpend.get(budgetKey) || 0;
    const budgetRemaining = this.config.budgetPerKeyDailyUsd - currentSpend;

    if (estimate.totalEstimatedCostUsd > budgetRemaining) {
      violations.push({
        rule: 'daily_budget',
        message: `Estimated cost ($${estimate.totalEstimatedCostUsd.toFixed(4)}) would exceed remaining daily budget ($${budgetRemaining.toFixed(4)})`,
        severity: this.config.blockOnBudgetExceeded ? 'error' : 'warning',
      });
      if (this.config.blockOnBudgetExceeded) {
        action = PolicyAction.BLOCK;
      }
    }

    const result: PolicyResult = {
      action,
      violations,
      modifications,
      budgetRemaining: Math.max(0, budgetRemaining),
    };

    if (violations.length > 0) {
      log.info({
        action,
        violations: violations.length,
        apiKey: request.apiKey.slice(0, 8) + '...',
      }, 'Policy violations found');
    }

    return result;
  }

  /**
   * Record actual spend after execution.
   * Called by the pipeline after a successful Claude call.
   */
  recordSpend(apiKey: string, costUsd: number): void {
    const key = this.getBudgetKey(apiKey);
    const current = dailySpend.get(key) || 0;
    dailySpend.set(key, current + costUsd);
    log.debug({ apiKey: apiKey.slice(0, 8) + '...', costUsd, total: current + costUsd }, 'Spend recorded');
  }

  /** Get current daily spend for an API key. */
  getSpend(apiKey: string): number {
    return dailySpend.get(this.getBudgetKey(apiKey)) || 0;
  }

  /** Get remaining budget for an API key. */
  getBudgetRemaining(apiKey: string): number {
    return Math.max(0, this.config.budgetPerKeyDailyUsd - this.getSpend(apiKey));
  }

  /** Budget key format: "hash(apiKey):YYYY-MM-DD" */
  private getBudgetKey(apiKey: string): string {
    const date = new Date().toISOString().split('T')[0];
    // Use first 12 chars as key identifier (don't store full key in memory)
    return `${apiKey.slice(0, 12)}:${date}`;
  }
}
