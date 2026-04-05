/**
 * ============================================================
 * Quota — Configuration Module
 * ============================================================
 * PURPOSE: Centralized, validated configuration loaded from
 * environment variables. Fails fast on invalid config to
 * prevent runtime surprises in production.
 * ============================================================
 */

import dotenv from 'dotenv';
import { ClaudeModel } from '../types';

dotenv.config();

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseFloat(val) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

export const config = {
  // Server
  port: envInt('PORT', 3100),
  nodeEnv: envStr('NODE_ENV', 'development'),
  logLevel: envStr('LOG_LEVEL', 'info'),

  // Anthropic
  anthropicApiKey: envStr('ANTHROPIC_API_KEY', ''),

  // Redis
  redis: {
    enabled: envBool('REDIS_ENABLED', false),
    url: envStr('REDIS_URL', 'redis://localhost:6379'),
  },

  // Cache
  cache: {
    ttlSeconds: envInt('CACHE_TTL_SECONDS', 3600),
    maxSize: envInt('CACHE_MAX_SIZE', 10000),
  },

  // Policy defaults
  policy: {
    maxTokensPerRequest: envInt('DEFAULT_MAX_TOKENS_PER_REQUEST', 100000),
    maxOutputTokens: envInt('DEFAULT_MAX_OUTPUT_TOKENS', 4096),
    budgetPerKeyDailyUsd: envFloat('DEFAULT_BUDGET_PER_KEY_DAILY_USD', 50.0),
    defaultModel: envStr('DEFAULT_MODEL', ClaudeModel.SONNET_4) as ClaudeModel,
  },

  // Rate limiting
  rateLimit: {
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
    maxRequests: envInt('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  // Optimization
  optimization: {
    autoSummarizeThresholdTokens: envInt('AUTO_SUMMARIZE_THRESHOLD_TOKENS', 50000),
    dedupWindowSeconds: envInt('DEDUP_WINDOW_SECONDS', 300),
    promptTrimEnabled: envBool('PROMPT_TRIM_ENABLED', true),
  },
} as const;

/** Validate critical config at startup. */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.anthropicApiKey || config.anthropicApiKey === 'sk-ant-your-key-here') {
    errors.push('ANTHROPIC_API_KEY must be set to a valid key');
  }

  if (config.policy.budgetPerKeyDailyUsd <= 0) {
    errors.push('DEFAULT_BUDGET_PER_KEY_DAILY_USD must be positive');
  }

  if (errors.length > 0) {
    // In development, warn but don't crash — allows testing without a real key
    if (config.nodeEnv === 'production') {
      throw new Error(`Configuration errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }
    console.warn(`[Quota Config] Warnings:\n${errors.map(e => `  ⚠ ${e}`).join('\n')}`);
  }
}
