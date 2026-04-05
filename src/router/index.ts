/**
 * ============================================================
 * Quota — Model Router
 * ============================================================
 * PURPOSE: Selects the most cost-efficient Claude model that
 * can handle the task at the required quality level.
 *
 * ROUTING LOGIC:
 *   1. If caller explicitly specified a model → use it (unless blocked by policy)
 *   2. Otherwise, match task complexity to the cheapest capable model:
 *      - SIMPLE  → Haiku (cheapest)
 *      - MODERATE → Sonnet (balanced)
 *      - COMPLEX → Opus (most capable)
 *   3. If budget is tight, downgrade one tier if possible
 *
 * DATA FLOW: Optimizer → Router → Executor
 * ============================================================
 */

import {
  ClaudeModel,
  TaskComplexity,
  AnalysisResult,
  CostEstimate,
  PolicyResult,
  MODEL_CAPABILITY_TIER,
} from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('router');

/** Maps complexity to the minimum model tier needed. */
const COMPLEXITY_TO_MIN_TIER: Record<TaskComplexity, number> = {
  [TaskComplexity.SIMPLE]: 1,
  [TaskComplexity.MODERATE]: 2,
  [TaskComplexity.COMPLEX]: 3,
};

/** Models sorted by cost (cheapest first). */
const MODELS_BY_COST: ClaudeModel[] = [
  ClaudeModel.HAIKU_4,
  ClaudeModel.SONNET_4,
  ClaudeModel.OPUS_4,
];

export class ModelRouter {
  /**
   * Select the optimal model for this request.
   *
   * @param requestedModel - Model the caller asked for (may be null)
   * @param analysis - Task complexity and token analysis
   * @param estimate - Cost estimates per model
   * @param policy - Budget constraints from policy engine
   * @returns The selected model
   */
  route(
    requestedModel: ClaudeModel | undefined,
    analysis: AnalysisResult,
    estimate: CostEstimate,
    policy: PolicyResult
  ): ClaudeModel {
    // If caller explicitly requested a model and it wasn't blocked, respect it
    if (requestedModel) {
      log.debug({ model: requestedModel, reason: 'explicit_request' }, 'Model selected');
      return requestedModel;
    }

    // Find the cheapest model that meets the complexity requirement
    const minTier = COMPLEXITY_TO_MIN_TIER[analysis.taskComplexity];
    let selected: ClaudeModel | null = null;

    for (const model of MODELS_BY_COST) {
      const tier = MODEL_CAPABILITY_TIER[model];
      if (tier >= minTier) {
        // Check if this model fits within budget
        const modelCost = estimate.alternativeModels[model];
        if (modelCost <= policy.budgetRemaining) {
          selected = model;
          break;
        }
      }
    }

    // If no model fits budget, pick the cheapest available
    if (!selected) {
      selected = MODELS_BY_COST[0];
      log.warn({
        budget: policy.budgetRemaining,
        cheapest: estimate.alternativeModels[selected],
      }, 'Budget tight — routing to cheapest model');
    }

    // Budget pressure: if remaining budget is < 20% of daily, downgrade one tier
    if (policy.budgetRemaining < estimate.totalEstimatedCostUsd * 5) {
      const downgradedIdx = Math.max(0, MODELS_BY_COST.indexOf(selected) - 1);
      const downgraded = MODELS_BY_COST[downgradedIdx];
      if (downgraded !== selected) {
        log.info({
          from: selected,
          to: downgraded,
          reason: 'budget_pressure',
        }, 'Downgrading model due to budget pressure');
        selected = downgraded;
      }
    }

    log.debug({
      model: selected,
      complexity: analysis.taskComplexity,
      cost: estimate.alternativeModels[selected],
    }, 'Model routed');

    return selected;
  }
}
