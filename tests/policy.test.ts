/**
 * ============================================================
 * Tests — Policy Engine
 * ============================================================
 */

import { PolicyEngine } from '../src/policy';
import { RequestAnalyzer } from '../src/analyzer';
import { CostEstimator } from '../src/estimator';
import { ClaudeModel, PolicyAction, QuotaRequest } from '../src/types';

describe('PolicyEngine', () => {
  const analyzer = new RequestAnalyzer();
  const estimator = new CostEstimator();

  test('allows valid requests', () => {
    const policy = new PolicyEngine();
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const analysis = analyzer.analyze(request);
    const estimate = estimator.estimate(analysis);
    const result = policy.evaluate(request, analysis, estimate);

    expect(result.action).toBe(PolicyAction.ALLOW);
    expect(result.violations).toHaveLength(0);
  });

  test('blocks requests exceeding token limit', () => {
    const policy = new PolicyEngine({ maxTokensPerRequest: 10 });
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'This message is definitely longer than 10 tokens for testing' }],
    };
    const analysis = analyzer.analyze(request);
    const estimate = estimator.estimate(analysis);
    const result = policy.evaluate(request, analysis, estimate);

    expect(result.action).toBe(PolicyAction.BLOCK);
    expect(result.violations.some(v => v.rule === 'max_tokens_per_request')).toBe(true);
  });

  test('modifies requests exceeding output token cap', () => {
    const policy = new PolicyEngine({ maxOutputTokens: 100 });
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 5000,
    };
    const analysis = analyzer.analyze(request);
    const estimate = estimator.estimate(analysis);
    const result = policy.evaluate(request, analysis, estimate);

    expect(result.action).toBe(PolicyAction.MODIFY);
    expect(result.modifications.maxTokens).toBe(100);
  });

  test('blocks restricted models', () => {
    const policy = new PolicyEngine({ allowedModels: [ClaudeModel.HAIKU_4] });
    const request: QuotaRequest = {
      apiKey: 'test-key',
      model: ClaudeModel.OPUS_4,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const analysis = analyzer.analyze(request);
    const estimate = estimator.estimate(analysis);
    const result = policy.evaluate(request, analysis, estimate);

    expect(result.action).toBe(PolicyAction.BLOCK);
    expect(result.violations.some(v => v.rule === 'model_restriction')).toBe(true);
  });

  test('tracks and enforces daily budget', () => {
    const policy = new PolicyEngine({ budgetPerKeyDailyUsd: 0.001 });

    // Record spend that exceeds budget
    policy.recordSpend('test-budget-key', 0.002);

    const request: QuotaRequest = {
      apiKey: 'test-budget-key',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const analysis = analyzer.analyze(request);
    const estimate = estimator.estimate(analysis);
    const result = policy.evaluate(request, analysis, estimate);

    expect(result.action).toBe(PolicyAction.BLOCK);
    expect(result.violations.some(v => v.rule === 'daily_budget')).toBe(true);
  });
});
