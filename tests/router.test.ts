/**
 * ============================================================
 * Tests — Model Router
 * ============================================================
 */

import { ModelRouter } from '../src/router';
import {
  ClaudeModel,
  TaskComplexity,
  AnalysisResult,
  CostEstimate,
  PolicyResult,
  PolicyAction,
  MODEL_PRICING,
} from '../src/types';

describe('ModelRouter', () => {
  const router = new ModelRouter();

  const makeAnalysis = (complexity: TaskComplexity): AnalysisResult => ({
    totalInputTokens: 1000,
    estimatedOutputTokens: 500,
    messageCount: 2,
    avgMessageLength: 500,
    hasSystemPrompt: false,
    taskComplexity: complexity,
    contentFingerprint: 'abc123',
  });

  const makeEstimate = (): CostEstimate => ({
    model: ClaudeModel.SONNET_4,
    inputTokens: 1000,
    estimatedOutputTokens: 500,
    inputCostUsd: 0.003,
    outputCostUsd: 0.0075,
    totalEstimatedCostUsd: 0.0105,
    alternativeModels: {
      [ClaudeModel.HAIKU_4]: 0.003,
      [ClaudeModel.SONNET_4]: 0.0105,
      [ClaudeModel.OPUS_4]: 0.0525,
    },
  });

  const makePolicy = (remaining: number = 50): PolicyResult => ({
    action: PolicyAction.ALLOW,
    violations: [],
    modifications: {},
    budgetRemaining: remaining,
  });

  test('respects explicit model choice', () => {
    const result = router.route(
      ClaudeModel.OPUS_4,
      makeAnalysis(TaskComplexity.SIMPLE),
      makeEstimate(),
      makePolicy()
    );
    expect(result).toBe(ClaudeModel.OPUS_4);
  });

  test('routes simple tasks to Haiku', () => {
    const result = router.route(
      undefined,
      makeAnalysis(TaskComplexity.SIMPLE),
      makeEstimate(),
      makePolicy()
    );
    expect(result).toBe(ClaudeModel.HAIKU_4);
  });

  test('routes moderate tasks to Sonnet', () => {
    const result = router.route(
      undefined,
      makeAnalysis(TaskComplexity.MODERATE),
      makeEstimate(),
      makePolicy()
    );
    expect(result).toBe(ClaudeModel.SONNET_4);
  });

  test('routes complex tasks to Opus', () => {
    const result = router.route(
      undefined,
      makeAnalysis(TaskComplexity.COMPLEX),
      makeEstimate(),
      makePolicy()
    );
    expect(result).toBe(ClaudeModel.OPUS_4);
  });
});
