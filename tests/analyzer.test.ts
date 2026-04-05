/**
 * ============================================================
 * Tests — Request Analyzer
 * ============================================================
 */

import { RequestAnalyzer } from '../src/analyzer';
import { QuotaRequest, ClaudeModel, TaskComplexity } from '../src/types';

describe('RequestAnalyzer', () => {
  const analyzer = new RequestAnalyzer();

  const makeRequest = (content: string, messageCount = 1): QuotaRequest => ({
    apiKey: 'test-key-123',
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i === messageCount - 1 ? content : 'Previous message context',
    })),
  });

  test('analyzes a simple request', () => {
    const result = analyzer.analyze(makeRequest('Translate hello to French'));
    expect(result.totalInputTokens).toBeGreaterThan(0);
    expect(result.messageCount).toBe(1);
    expect(result.taskComplexity).toBe(TaskComplexity.SIMPLE);
    expect(result.contentFingerprint).toHaveLength(16);
  });

  test('classifies complex tasks', () => {
    // Long multi-turn conversation with complex keywords and substantial content
    const longPrompt = 'Analyze this codebase and implement a distributed cache with replication. ' +
      'This requires multi-step reasoning across the architecture. '.repeat(50);
    const result = analyzer.analyze(makeRequest(longPrompt, 13));
    expect(result.taskComplexity).toBe(TaskComplexity.COMPLEX);
  });

  test('detects system prompts', () => {
    const req: QuotaRequest = {
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Hello' }],
      system: 'You are a helpful assistant',
    };
    const result = analyzer.analyze(req);
    expect(result.hasSystemPrompt).toBe(true);
    expect(result.totalInputTokens).toBeGreaterThan(
      analyzer.analyze(makeRequest('Hello')).totalInputTokens
    );
  });

  test('generates consistent fingerprints', () => {
    const req = makeRequest('Same content');
    const r1 = analyzer.analyze(req);
    const r2 = analyzer.analyze(req);
    expect(r1.contentFingerprint).toBe(r2.contentFingerprint);
  });

  test('generates different fingerprints for different content', () => {
    const r1 = analyzer.analyze(makeRequest('Content A'));
    const r2 = analyzer.analyze(makeRequest('Content B'));
    expect(r1.contentFingerprint).not.toBe(r2.contentFingerprint);
  });
});
