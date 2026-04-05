/**
 * ============================================================
 * Quota — Cost Estimator
 * ============================================================
 * PURPOSE: Calculates the estimated cost of an AI request
 * BEFORE execution. Provides cost breakdowns across all
 * available models so the router can make informed decisions.
 *
 * PRICING MODEL: Based on Anthropic's per-1M-token pricing.
 * Input and output tokens are priced differently.
 *
 * DATA FLOW: Analyzer → Estimator → (feeds into Policy + Router)
 * ============================================================
 */

import {
  AnalysisResult,
  CostEstimate,
  ClaudeModel,
  MODEL_PRICING,
} from '../types';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('estimator');

export class CostEstimator {
  /**
   * Estimate cost for a request across the target model and all alternatives.
   *
   * @param analysis - Output from the RequestAnalyzer
   * @param requestedModel - The model the caller wants (or default)
   * @returns Full cost breakdown with per-model alternatives
   */
  estimate(analysis: AnalysisResult, requestedModel?: ClaudeModel): CostEstimate {
    const model = requestedModel || config.policy.defaultModel;
    const pricing = MODEL_PRICING[model];

    const inputCostUsd = this.calculateCost(analysis.totalInputTokens, pricing.inputPer1M);
    const outputCostUsd = this.calculateCost(analysis.estimatedOutputTokens, pricing.outputPer1M);
    const totalEstimatedCostUsd = inputCostUsd + outputCostUsd;

    // Calculate costs for all models — router uses this
    const alternativeModels = {} as Record<ClaudeModel, number>;
    for (const [m, p] of Object.entries(MODEL_PRICING)) {
      const altInput = this.calculateCost(analysis.totalInputTokens, p.inputPer1M);
      const altOutput = this.calculateCost(analysis.estimatedOutputTokens, p.outputPer1M);
      alternativeModels[m as ClaudeModel] = parseFloat((altInput + altOutput).toFixed(6));
    }

    const estimate: CostEstimate = {
      model,
      inputTokens: analysis.totalInputTokens,
      estimatedOutputTokens: analysis.estimatedOutputTokens,
      inputCostUsd: parseFloat(inputCostUsd.toFixed(6)),
      outputCostUsd: parseFloat(outputCostUsd.toFixed(6)),
      totalEstimatedCostUsd: parseFloat(totalEstimatedCostUsd.toFixed(6)),
      alternativeModels,
    };

    log.debug({
      model,
      inputTokens: analysis.totalInputTokens,
      outputTokens: analysis.estimatedOutputTokens,
      costUsd: totalEstimatedCostUsd,
    }, 'Cost estimated');

    return estimate;
  }

  /**
   * Calculate cost for a given token count at a per-1M rate.
   * Formula: (tokens / 1,000,000) * ratePer1M
   */
  private calculateCost(tokens: number, ratePer1M: number): number {
    return (tokens / 1_000_000) * ratePer1M;
  }
}
