/**
 * ============================================================
 * Quota — Cache Layer
 * ============================================================
 * PURPOSE: Caches Claude API responses to avoid paying for
 * identical requests twice. Supports two backends:
 *   - Redis (production, shared across instances)
 *   - In-memory LRU (development, single instance)
 *
 * CACHE KEY: SHA-256 of (model + messages + system + temperature).
 * This ensures semantically identical requests hit cache
 * regardless of metadata differences.
 *
 * EVICTION: TTL-based (default 1h) + LRU for memory backend.
 *
 * DATA FLOW: Pre-execution check → (hit: return cached) or
 *            Post-execution → store result
 * ============================================================
 */

import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { ExecutionResult, QuotaRequest } from '../types';

const log = createLogger('cache');

interface CacheEntry {
  result: ExecutionResult;
  storedAt: number;
}

export class CacheLayer {
  private memoryCache: LRUCache<string, CacheEntry>;
  private redisClient: any | null = null;
  private stats = { hits: 0, misses: 0 };

  constructor() {
    // In-memory LRU cache — always available
    this.memoryCache = new LRUCache<string, CacheEntry>({
      max: config.cache.maxSize,
      ttl: config.cache.ttlSeconds * 1000,
    });

    // Redis — optional, for multi-instance deployments
    if (config.redis.enabled) {
      this.initRedis();
    }
  }

  private async initRedis(): Promise<void> {
    try {
      const Redis = (await import('ioredis')).default;
      this.redisClient = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 200, 3000),
        lazyConnect: true,
      });
      await this.redisClient.connect();
      log.info('Redis cache connected');
    } catch (err) {
      log.warn({ err }, 'Redis unavailable, falling back to memory cache');
      this.redisClient = null;
    }
  }

  /**
   * Generate a deterministic cache key from the request.
   * Only content-affecting fields are included in the hash.
   */
  generateKey(request: QuotaRequest, model: string): string {
    const payload = JSON.stringify({
      model,
      messages: request.messages,
      system: request.system || '',
      temperature: request.temperature ?? 1,
    });
    return `quota:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  }

  /** Look up a cached response. Returns null on miss. */
  async get(key: string): Promise<ExecutionResult | null> {
    // Try Redis first if available
    if (this.redisClient) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw) {
          this.stats.hits++;
          log.debug({ key: key.slice(0, 16) }, 'Redis cache hit');
          return JSON.parse(raw).result;
        }
      } catch (err) {
        log.warn({ err }, 'Redis get failed, trying memory cache');
      }
    }

    // Fall back to memory cache
    const entry = this.memoryCache.get(key);
    if (entry) {
      this.stats.hits++;
      log.debug({ key: key.slice(0, 16) }, 'Memory cache hit');
      return entry.result;
    }

    this.stats.misses++;
    return null;
  }

  /** Store a response in the cache. */
  async set(key: string, result: ExecutionResult): Promise<void> {
    const entry: CacheEntry = { result, storedAt: Date.now() };

    // Write to memory cache always
    this.memoryCache.set(key, entry);

    // Write to Redis if available
    if (this.redisClient) {
      try {
        await this.redisClient.setex(
          key,
          config.cache.ttlSeconds,
          JSON.stringify(entry)
        );
      } catch (err) {
        log.warn({ err }, 'Redis set failed');
      }
    }

    log.debug({ key: key.slice(0, 16) }, 'Response cached');
  }

  /** Get cache hit rate statistics. */
  getStats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      size: this.memoryCache.size,
    };
  }

  /** Clear all cached entries. */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    if (this.redisClient) {
      try {
        // Only clear quota keys, not all Redis data
        const keys = await this.redisClient.keys('quota:*');
        if (keys.length > 0) await this.redisClient.del(...keys);
      } catch (err) {
        log.warn({ err }, 'Redis clear failed');
      }
    }
    this.stats = { hits: 0, misses: 0 };
    log.info('Cache cleared');
  }

  /** Graceful shutdown — close Redis connection. */
  async shutdown(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit();
      log.info('Redis connection closed');
    }
  }
}
