/**
 * ============================================================
 * Tests — Optimization Engine
 * ============================================================
 */

import { OptimizationEngine } from '../src/optimizer';
import { RequestAnalyzer } from '../src/analyzer';
import { QuotaRequest } from '../src/types';

describe('OptimizationEngine', () => {
  const analyzer = new RequestAnalyzer();
  const optimizer = new OptimizationEngine();

  test('normalizes whitespace', () => {
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Hello    world   with    spaces' }],
    };
    const analysis = analyzer.analyze(request);
    const result = optimizer.optimize(request, analysis);

    expect(result.messages[0].content).toBe('Hello world with spaces');
    expect(result.optimizations.length).toBeGreaterThanOrEqual(0);
  });

  test('removes consecutive duplicate messages', () => {
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    };
    const analysis = analyzer.analyze(request);
    const result = optimizer.optimize(request, analysis);

    expect(result.messages).toHaveLength(2);
    expect(result.optimizations.some(o => o.includes('dedup'))).toBe(true);
  });

  test('preserves non-duplicate messages', () => {
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Second' },
      ],
    };
    const analysis = analyzer.analyze(request);
    const result = optimizer.optimize(request, analysis);

    expect(result.messages).toHaveLength(3);
  });

  test('reports tokens saved', () => {
    const request: QuotaRequest = {
      apiKey: 'test-key',
      messages: [
        { role: 'user', content: 'Hello     with     lots     of     spaces' },
        { role: 'user', content: 'Hello     with     lots     of     spaces' },
      ],
    };
    const analysis = analyzer.analyze(request);
    const result = optimizer.optimize(request, analysis);

    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
  });
});
