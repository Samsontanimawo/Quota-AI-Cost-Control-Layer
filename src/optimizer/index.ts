/**
 * ============================================================
 * Quota — Optimization Engine
 * ============================================================
 * PURPOSE: Reduces token usage (and therefore cost) by applying
 * intelligent transformations to the request before execution.
 *
 * STRATEGIES (applied in order):
 *   1. Whitespace normalization — removes redundant whitespace
 *   2. Message deduplication — removes exact duplicate messages
 *   3. Context trimming — drops oldest messages if over threshold
 *   4. System prompt compression — trims verbose system prompts
 *
 * INVARIANT: Optimizations must never change the semantic intent
 * of the request. If unsure, skip the optimization.
 *
 * DATA FLOW: Policy(allow/modify) → Optimizer → Router
 * ============================================================
 */

import {
  QuotaRequest,
  QuotaMessage,
  AnalysisResult,
  OptimizedRequest,
} from '../types';
import { countTokens } from '../utils/tokenizer';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('optimizer');

export class OptimizationEngine {
  /**
   * Apply all applicable optimizations to the request.
   * Returns the optimized messages and a report of what changed.
   */
  optimize(request: QuotaRequest, analysis: AnalysisResult): OptimizedRequest {
    let messages = [...request.messages];
    let system = request.system;
    const optimizations: string[] = [];
    const originalTokens = analysis.totalInputTokens;

    // Strategy 1: Whitespace normalization
    const wsResult = this.normalizeWhitespace(messages, system);
    messages = wsResult.messages;
    system = wsResult.system;
    if (wsResult.saved > 0) {
      optimizations.push(`whitespace_normalization(-${wsResult.saved} tokens)`);
    }

    // Strategy 2: Message deduplication — remove consecutive exact duplicates
    const dedupResult = this.deduplicateMessages(messages);
    if (dedupResult.removed > 0) {
      messages = dedupResult.messages;
      optimizations.push(`dedup_removed(${dedupResult.removed} duplicate messages)`);
    }

    // Strategy 3: Context trimming — if total tokens exceed threshold,
    // drop oldest messages while preserving the system prompt and last N messages
    if (config.optimization.promptTrimEnabled) {
      const currentTokens = this.countTotalTokens(messages, system);
      if (currentTokens > config.optimization.autoSummarizeThresholdTokens) {
        const trimResult = this.trimContext(messages, currentTokens);
        messages = trimResult.messages;
        if (trimResult.removed > 0) {
          optimizations.push(`context_trimmed(${trimResult.removed} old messages dropped)`);
        }
      }
    }

    // Strategy 4: System prompt compression
    if (system && countTokens(system) > 2000) {
      const compressed = this.compressSystemPrompt(system);
      if (compressed.saved > 0) {
        system = compressed.text;
        optimizations.push(`system_prompt_compressed(-${compressed.saved} tokens)`);
      }
    }

    const finalTokens = this.countTotalTokens(messages, system);
    const tokensSaved = Math.max(0, originalTokens - finalTokens);

    if (optimizations.length > 0) {
      log.info({
        originalTokens,
        finalTokens,
        tokensSaved,
        optimizations,
      }, 'Request optimized');
    }

    return {
      messages,
      system: system || undefined,
      tokensSaved,
      optimizations,
    };
  }

  /** Collapse multiple whitespace chars to single space, trim lines. */
  private normalizeWhitespace(
    messages: QuotaMessage[],
    system?: string
  ): { messages: QuotaMessage[]; system?: string; saved: number } {
    const beforeTokens = this.countTotalTokens(messages, system);

    const normalized = messages.map(m => ({
      ...m,
      content: m.content.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    }));

    const normalizedSystem = system
      ? system.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      : undefined;

    const afterTokens = this.countTotalTokens(normalized, normalizedSystem);

    return {
      messages: normalized,
      system: normalizedSystem,
      saved: Math.max(0, beforeTokens - afterTokens),
    };
  }

  /** Remove consecutive duplicate messages (same role + content). */
  private deduplicateMessages(
    messages: QuotaMessage[]
  ): { messages: QuotaMessage[]; removed: number } {
    const deduped: QuotaMessage[] = [];
    let removed = 0;

    for (let i = 0; i < messages.length; i++) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.role === messages[i].role && prev.content === messages[i].content) {
        removed++;
        continue;
      }
      deduped.push(messages[i]);
    }

    return { messages: deduped, removed };
  }

  /**
   * Trim context by dropping oldest messages while preserving
   * the most recent conversation turns.
   * Keeps at minimum the last 4 messages (2 turns).
   */
  private trimContext(
    messages: QuotaMessage[],
    currentTokens: number
  ): { messages: QuotaMessage[]; removed: number } {
    const target = config.optimization.autoSummarizeThresholdTokens * 0.8;
    const minKeep = Math.min(4, messages.length);
    let trimmed = [...messages];
    let removed = 0;

    // Remove from the front (oldest) until under target
    while (
      trimmed.length > minKeep &&
      this.countTotalTokens(trimmed) > target
    ) {
      trimmed.shift();
      removed++;
    }

    return { messages: trimmed, removed };
  }

  /**
   * Compress system prompts by removing excessive formatting,
   * redundant instructions, and verbose boilerplate.
   */
  private compressSystemPrompt(system: string): { text: string; saved: number } {
    const beforeTokens = countTokens(system);

    let compressed = system;
    // Remove markdown headers (## / ### / ####) — the content is still there
    compressed = compressed.replace(/^#{2,4}\s+/gm, '');
    // Remove horizontal rules
    compressed = compressed.replace(/^[-=]{3,}$/gm, '');
    // Collapse multiple blank lines
    compressed = compressed.replace(/\n{3,}/g, '\n\n');
    // Remove trailing whitespace on lines
    compressed = compressed.replace(/[ \t]+$/gm, '');

    const afterTokens = countTokens(compressed);
    return {
      text: compressed,
      saved: Math.max(0, beforeTokens - afterTokens),
    };
  }

  private countTotalTokens(messages: QuotaMessage[], system?: string): number {
    const msgTokens = messages.reduce((sum, m) => sum + countTokens(m.content), 0);
    const sysTokens = system ? countTokens(system) : 0;
    return msgTokens + sysTokens;
  }
}
