/**
 * ============================================================
 * Quota — Execution Layer
 * ============================================================
 * PURPOSE: The only component that actually calls the Claude API.
 * Handles request construction, execution, retries on transient
 * failures, and response normalization.
 *
 * RETRY POLICY:
 *   - 3 attempts with exponential backoff (1s, 2s, 4s)
 *   - Retries on: 429 (rate limit), 500/502/503 (server errors)
 *   - Does NOT retry on: 400 (bad request), 401 (auth), 404
 *
 * DATA FLOW: Router(model selected) → Executor → Cache + Logger
 * ============================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeModel,
  ExecutionResult,
  OptimizedRequest,
  MODEL_PRICING,
} from '../types';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('executor');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class ExecutionLayer {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }

  /**
   * Execute a request against the Claude API.
   *
   * @param optimized - The optimized messages to send
   * @param model - The model selected by the router
   * @param maxTokens - Maximum output tokens
   * @param temperature - Sampling temperature
   * @returns Normalized execution result with actual token counts and cost
   */
  async execute(
    optimized: OptimizedRequest,
    model: ClaudeModel,
    maxTokens: number = 4096,
    temperature?: number
  ): Promise<ExecutionResult> {
    const startMs = Date.now();

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: optimized.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      ...(optimized.system && { system: optimized.system }),
      ...(temperature !== undefined && { temperature }),
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        log.debug({ model, attempt, maxTokens }, 'Calling Claude API');

        const response = await this.client.messages.create(params);

        const latencyMs = Date.now() - startMs;
        const inputTokens = response.usage.input_tokens;
        const outputTokens = response.usage.output_tokens;

        // Extract text content from the response
        const content = response.content
          .filter(block => block.type === 'text')
          .map(block => (block as Anthropic.TextBlock).text)
          .join('');

        // Calculate actual cost from real token counts
        const pricing = MODEL_PRICING[model];
        const actualCostUsd = parseFloat(
          (
            (inputTokens / 1_000_000) * pricing.inputPer1M +
            (outputTokens / 1_000_000) * pricing.outputPer1M
          ).toFixed(6)
        );

        const result: ExecutionResult = {
          content,
          model,
          inputTokens,
          outputTokens,
          actualCostUsd,
          latencyMs,
          stopReason: response.stop_reason || 'unknown',
        };

        log.info({
          model,
          inputTokens,
          outputTokens,
          costUsd: actualCostUsd,
          latencyMs,
          stopReason: response.stop_reason,
        }, 'Claude API call completed');

        return result;
      } catch (err: any) {
        lastError = err;
        const status = err?.status || err?.statusCode;

        // Don't retry on client errors (except rate limiting)
        if (status && status >= 400 && status < 500 && status !== 429) {
          log.error({ status, message: err.message }, 'Non-retryable API error');
          throw err;
        }

        // Retry with exponential backoff
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          log.warn({
            attempt,
            status,
            delay,
            message: err.message,
          }, 'Retrying Claude API call');
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    log.error({ retries: MAX_RETRIES, error: lastError?.message }, 'All retries failed');
    throw lastError || new Error('Execution failed after all retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
