/**
 * ============================================================
 * Tests — Cost Estimator
 * ============================================================
 */

import { CostEstimator } from '../src/estimator';
import { RequestAnalyzer } from '../src/analyzer';
import { ClaudeModel, QuotaRequest } from '../src/types';

describe('CostEstimator', () => {
  const analyzer = new RequestAnalyzer();
  const estimator = new CostEstimator();

  const makeRequest = (content: string): QuotaRequest => ({
    apiKey: 'test-key',
    messages: [{ role: 'user', content }],
  });

  test('estimates cost for a request', () => {
    const analysis = analyzer.analyze(makeRequest('What is 2+2?'));
    const estimate = estimator.estimate(analysis, ClaudeModel.SONNET_4);

    expect(estimate.model).toBe(ClaudeModel.SONNET_4);
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedOutputTokens).toBeGreaterThan(0);
    expect(estimate.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(estimate.inputCostUsd).toBeGreaterThanOrEqual(0);
    expect(estimate.outputCostUsd).toBeGreaterThanOrEqual(0);
  });

  test('provides alternative model costs', () => {
    const analysis = analyzer.analyze(makeRequest('Hello world'));
    const estimate = estimator.estimate(analysis, ClaudeModel.OPUS_4);

    // Haiku should be cheapest, Opus most expensive
    expect(estimate.alternativeModels[ClaudeModel.HAIKU_4])
      .toBeLessThan(estimate.alternativeModels[ClaudeModel.OPUS_4]);
    expect(estimate.alternativeModels[ClaudeModel.SONNET_4])
      .toBeLessThan(estimate.alternativeModels[ClaudeModel.OPUS_4]);
  });

  test('cost scales with input size', () => {
    const short = estimator.estimate(
      analyzer.analyze(makeRequest('Hi')),
      ClaudeModel.SONNET_4
    );
    const long = estimator.estimate(
      analyzer.analyze(makeRequest('Tell me everything about ' + 'x '.repeat(5000))),
      ClaudeModel.SONNET_4
    );

    expect(long.totalEstimatedCostUsd).toBeGreaterThan(short.totalEstimatedCostUsd);
  });
});
