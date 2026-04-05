/**
 * ============================================================
 * Quota — Request Analyzer
 * ============================================================
 * PURPOSE: Parses and classifies incoming AI requests. Computes
 * token counts, determines task complexity, and generates a
 * content fingerprint for deduplication.
 *
 * DATA FLOW: Gateway → Analyzer → (feeds into Estimator, Policy, Optimizer)
 *
 * COMPLEXITY CLASSIFICATION:
 *   - SIMPLE: Short prompts, classification, translation
 *   - MODERATE: Summarization, Q&A with context
 *   - COMPLEX: Multi-turn reasoning, code generation, analysis
 * ============================================================
 */

import crypto from 'crypto';
import { QuotaRequest, AnalysisResult, TaskComplexity, QuotaMessage } from '../types';
import { countTokens, estimateOutputTokens } from '../utils/tokenizer';
import { createLogger } from '../utils/logger';

const log = createLogger('analyzer');

// Keyword sets for complexity classification
const COMPLEX_KEYWORDS = [
  'analyze', 'implement', 'architect', 'design', 'debug', 'refactor',
  'optimize', 'write code', 'build', 'create a system', 'multi-step',
  'compare and contrast', 'evaluate', 'synthesize',
];

const SIMPLE_KEYWORDS = [
  'translate', 'classify', 'format', 'convert', 'list', 'yes or no',
  'true or false', 'one word', 'short answer',
];

export class RequestAnalyzer {
  /**
   * Analyze an incoming request and produce a structured analysis.
   * This is a pure computation — no side effects, no I/O.
   */
  analyze(request: QuotaRequest): AnalysisResult {
    const startMs = Date.now();

    // Count tokens across all messages + system prompt
    const messageTokens = request.messages.reduce(
      (sum, msg) => sum + countTokens(msg.content),
      0
    );
    const systemTokens = request.system ? countTokens(request.system) : 0;
    const totalInputTokens = messageTokens + systemTokens;

    // Estimate output tokens based on input size and max_tokens
    const estimatedOutputTokens = estimateOutputTokens(
      totalInputTokens,
      request.maxTokens
    );

    // Classify task complexity from the last user message
    const lastUserMessage = this.getLastUserMessage(request.messages);
    const taskComplexity = this.classifyComplexity(
      lastUserMessage,
      totalInputTokens,
      request.messages.length
    );

    // Generate fingerprint for deduplication
    const contentFingerprint = this.generateFingerprint(request);

    const avgMessageLength = request.messages.length > 0
      ? totalInputTokens / request.messages.length
      : 0;

    const result: AnalysisResult = {
      totalInputTokens,
      estimatedOutputTokens,
      messageCount: request.messages.length,
      avgMessageLength: Math.round(avgMessageLength),
      hasSystemPrompt: !!request.system,
      taskComplexity,
      contentFingerprint,
    };

    log.debug({
      tokens: totalInputTokens,
      complexity: taskComplexity,
      messages: request.messages.length,
      durationMs: Date.now() - startMs,
    }, 'Request analyzed');

    return result;
  }

  /** Extract the last user message for complexity analysis. */
  private getLastUserMessage(messages: QuotaMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
  }

  /**
   * Classify complexity using a combination of:
   * 1. Keyword matching in the prompt
   * 2. Token count (long prompts = more complex context)
   * 3. Conversation length (multi-turn = more complex)
   */
  private classifyComplexity(
    lastMessage: string,
    totalTokens: number,
    messageCount: number
  ): TaskComplexity {
    const lower = lastMessage.toLowerCase();
    let score = 0;

    // Keyword scoring
    if (COMPLEX_KEYWORDS.some(k => lower.includes(k))) score += 2;
    if (SIMPLE_KEYWORDS.some(k => lower.includes(k))) score -= 2;

    // Token count scoring
    if (totalTokens > 10000) score += 2;
    else if (totalTokens > 3000) score += 1;
    else if (totalTokens < 500) score -= 1;

    // Multi-turn scoring
    if (messageCount > 6) score += 1;
    if (messageCount > 12) score += 1;

    // Message length scoring — long user messages often indicate complex tasks
    if (lastMessage.length > 2000) score += 1;

    if (score >= 3) return TaskComplexity.COMPLEX;
    if (score >= 1) return TaskComplexity.MODERATE;
    return TaskComplexity.SIMPLE;
  }

  /**
   * SHA-256 fingerprint of the request content.
   * Used for exact-match dedup — not fuzzy matching.
   */
  private generateFingerprint(request: QuotaRequest): string {
    const content = JSON.stringify({
      messages: request.messages,
      system: request.system || '',
    });
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
