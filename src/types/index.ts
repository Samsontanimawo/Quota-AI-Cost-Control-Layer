/**
 * ============================================================
 * Quota — Core Type Definitions
 * ============================================================
 * PURPOSE: Central type registry for the entire Quota system.
 * All interfaces, enums, and type aliases used across modules
 * are defined here to ensure consistency and prevent drift.
 * ============================================================
 */

import { z } from 'zod';

// ─── Claude Model Definitions ────────────────────────────────

export enum ClaudeModel {
  OPUS_4 = 'claude-opus-4-6',
  SONNET_4 = 'claude-sonnet-4-6',
  HAIKU_4 = 'claude-haiku-4-5-20251001',
}

/**
 * Pricing per 1M tokens in USD.
 * Updated as of 2026-04. Source: Anthropic pricing page.
 * IMPORTANT: Keep this in sync with actual Anthropic pricing.
 */
export const MODEL_PRICING: Record<ClaudeModel, { inputPer1M: number; outputPer1M: number }> = {
  [ClaudeModel.OPUS_4]:   { inputPer1M: 15.00, outputPer1M: 75.00 },
  [ClaudeModel.SONNET_4]: { inputPer1M: 3.00,  outputPer1M: 15.00 },
  [ClaudeModel.HAIKU_4]:  { inputPer1M: 0.80,  outputPer1M: 4.00 },
};

/**
 * Model capability tiers — used by the router to match
 * task complexity to the cheapest capable model.
 */
export const MODEL_CAPABILITY_TIER: Record<ClaudeModel, number> = {
  [ClaudeModel.HAIKU_4]:  1,  // Fast, cheap — simple tasks
  [ClaudeModel.SONNET_4]: 2,  // Balanced — most tasks
  [ClaudeModel.OPUS_4]:   3,  // Most capable — complex reasoning
};

// ─── Request / Response Types ────────────────────────────────

/** Zod schema for incoming API requests — validated at the gateway. */
export const QuotaRequestSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  model: z.nativeEnum(ClaudeModel).optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).min(1, 'At least one message is required'),
  system: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string()).optional(),
});

export type QuotaRequest = z.infer<typeof QuotaRequestSchema>;

export interface QuotaMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The full context object that flows through the pipeline. */
export interface RequestContext {
  id: string;
  timestamp: number;
  original: QuotaRequest;
  analyzed: AnalysisResult | null;
  estimated: CostEstimate | null;
  policyResult: PolicyResult | null;
  optimized: OptimizedRequest | null;
  routedModel: ClaudeModel | null;
  response: ExecutionResult | null;
  cached: boolean;
  totalLatencyMs: number;
}

// ─── Analyzer Types ──────────────────────────────────────────

export enum TaskComplexity {
  SIMPLE = 'simple',       // Translation, formatting, classification
  MODERATE = 'moderate',   // Summarization, Q&A, code review
  COMPLEX = 'complex',     // Multi-step reasoning, long-form generation, coding
}

export interface AnalysisResult {
  totalInputTokens: number;
  estimatedOutputTokens: number;
  messageCount: number;
  avgMessageLength: number;
  hasSystemPrompt: boolean;
  taskComplexity: TaskComplexity;
  contentFingerprint: string;  // For dedup detection
}

// ─── Cost Estimator Types ────────────────────────────────────

export interface CostEstimate {
  model: ClaudeModel;
  inputTokens: number;
  estimatedOutputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalEstimatedCostUsd: number;
  /** Cost estimates for all models — used by the router. */
  alternativeModels: Record<ClaudeModel, number>;
}

// ─── Policy Engine Types ─────────────────────────────────────

export enum PolicyAction {
  ALLOW = 'allow',
  MODIFY = 'modify',     // Request will be modified (e.g., force cheaper model)
  BLOCK = 'block',
}

export interface PolicyViolation {
  rule: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface PolicyResult {
  action: PolicyAction;
  violations: PolicyViolation[];
  modifications: Partial<QuotaRequest>;
  budgetRemaining: number;
}

export interface PolicyConfig {
  maxTokensPerRequest: number;
  maxOutputTokens: number;
  budgetPerKeyDailyUsd: number;
  allowedModels: ClaudeModel[];
  blockOnBudgetExceeded: boolean;
}

// ─── Optimizer Types ─────────────────────────────────────────

export interface OptimizedRequest {
  messages: QuotaMessage[];
  system?: string;
  tokensSaved: number;
  optimizations: string[];  // List of optimizations applied
}

// ─── Execution Types ─────────────────────────────────────────

export interface ExecutionResult {
  content: string;
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
  latencyMs: number;
  stopReason: string;
}

// ─── Analytics Types ─────────────────────────────────────────

export interface UsageRecord {
  requestId: string;
  apiKey: string;
  timestamp: number;
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  savingsUsd: number;
  cached: boolean;
  optimizations: string[];
  latencyMs: number;
}

export interface UsageSummary {
  apiKey: string;
  period: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalSavingsUsd: number;
  cacheHitRate: number;
  modelBreakdown: Record<string, number>;
}

// ─── API Response Types ──────────────────────────────────────

export interface QuotaApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta: {
    requestId: string;
    latencyMs: number;
    cached: boolean;
    estimatedCostUsd: number;
    actualCostUsd: number;
    savingsUsd: number;
    optimizations: string[];
    model: string;
  };
}

export interface CostPreviewResponse {
  estimatedCostUsd: number;
  inputTokens: number;
  estimatedOutputTokens: number;
  recommendedModel: ClaudeModel;
  alternativeCosts: Record<string, number>;
  policyStatus: PolicyAction;
  violations: PolicyViolation[];
}
