# Quota — AI Cost Control Layer

**Quota** is a production-grade proxy layer that sits between your applications and the Claude API. Every AI request is intercepted, analyzed, optimized, and policy-checked **before** it reaches Claude — giving you full visibility and control over AI spend.

---

## Why Quota?

AI API costs can spiral fast. A single unoptimized request with a bloated context window can cost 10-50x more than necessary. Quota solves this by:

- **Estimating cost before execution** — know what you'll pay before you pay it
- **Enforcing budgets** — per-key daily spending limits that actually block overspend
- **Optimizing prompts** — automatic whitespace cleanup, dedup, and context trimming
- **Routing to the cheapest capable model** — simple tasks go to Haiku, not Opus
- **Caching responses** — identical requests return cached results at zero cost
- **Tracking everything** — per-key analytics, savings reports, model breakdowns

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    QUOTA API GATEWAY                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Analyzer │→ │Estimator │→ │  Policy  │→ │ Optimizer  │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                                                     │        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          ▼        │
│  │Analytics │← │  Cache   │← │ Executor │← ┌────────────┐  │
│  └──────────┘  └──────────┘  └──────────┘  │   Router   │  │
│                                             └────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Claude API (Anthropic)                     │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose |
|---|---|
| **API Gateway** | Single entry point. Validates requests, mounts middleware, exposes REST endpoints. |
| **Request Analyzer** | Counts tokens, classifies task complexity (simple/moderate/complex), generates content fingerprints for dedup detection. |
| **Cost Estimator** | Calculates estimated cost across all Claude models before any API call is made. |
| **Policy Engine** | Enforces rules: token limits, budget caps, model restrictions. Can allow, modify, or block requests. |
| **Optimization Engine** | Reduces token count via whitespace normalization, message deduplication, context trimming, and system prompt compression. |
| **Model Router** | Selects the cheapest Claude model that can handle the task. Simple questions go to Haiku ($0.80/1M), not Opus ($15/1M). |
| **Execution Layer** | Calls the Claude API with exponential backoff retries (3 attempts on transient failures). |
| **Cache Layer** | Stores responses in Redis (production) or in-memory LRU (development). Identical requests return instantly at zero cost. |
| **Analytics Service** | Records every request: tokens, cost, savings, cache hits. Provides per-key and global usage summaries. |

---

## Supported Models & Pricing

| Model | Tier | Input (per 1M tokens) | Output (per 1M tokens) | Best For |
|---|---|---|---|---|
| `claude-haiku-4-5-20251001` | Economy | $0.80 | $4.00 | Classification, translation, formatting |
| `claude-sonnet-4-6` | Balanced | $3.00 | $15.00 | Summarization, Q&A, code review |
| `claude-opus-4-6` | Premium | $15.00 | $75.00 | Complex reasoning, architecture, multi-step analysis |

Quota's router automatically picks the cheapest tier that matches the task complexity.

---

## Quick Start

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- Redis (optional — falls back to in-memory cache)

### 1. Clone & Install

```bash
git clone https://github.com/Samsontanimawo/Quota-AI-Cost-Control-Layer.git
cd Quota-AI-Cost-Control-Layer
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set your Anthropic API key:

```env
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
```

### 3. Run

**Development** (hot-reload):
```bash
npm run dev
```

**Production**:
```bash
npm run build
npm start
```

**Docker** (with Redis):
```bash
ANTHROPIC_API_KEY=sk-ant-xxx docker-compose up --build
```

The server starts on `http://localhost:3100`.

---

## API Reference

### `POST /api/v1/chat` — Execute a Request

Sends a request through the full Quota pipeline: analyze → estimate → cache check → policy → optimize → route → execute → cache store → log.

**Request:**
```json
{
  "apiKey": "your-api-key",
  "messages": [
    { "role": "user", "content": "Explain how TCP/IP works" }
  ],
  "system": "You are a networking expert.",
  "model": "claude-sonnet-4-6",
  "maxTokens": 1024,
  "temperature": 0.7
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `apiKey` | string | Yes | Your identifier for budget tracking |
| `messages` | array | Yes | Conversation messages (`role`: "user" or "assistant") |
| `system` | string | No | System prompt |
| `model` | string | No | Claude model (defaults to `claude-sonnet-4-6`). Omit to let the router choose. |
| `maxTokens` | number | No | Max output tokens (default: 4096) |
| `temperature` | number | No | Sampling temperature 0-1 |
| `metadata` | object | No | Arbitrary key-value pairs for your tracking |

**Response:**
```json
{
  "success": true,
  "data": {
    "content": "TCP/IP (Transmission Control Protocol/Internet Protocol) is...",
    "model": "claude-sonnet-4-6",
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 42,
      "outputTokens": 387
    }
  },
  "meta": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "latencyMs": 1847,
    "cached": false,
    "estimatedCostUsd": 0.005931,
    "actualCostUsd": 0.004120,
    "savingsUsd": 0.001811,
    "optimizations": ["whitespace_normalization(-12 tokens)"],
    "model": "claude-sonnet-4-6"
  }
}
```

The `meta` block shows exactly what Quota did: estimated vs actual cost, savings, and which optimizations were applied.

---

### `POST /api/v1/preview` — Estimate Cost Without Executing

Returns what a request **would** cost without calling the Claude API. Use this in UIs to show users the price before they confirm.

**Request:** Same body as `/chat`.

**Response:**
```json
{
  "success": true,
  "data": {
    "estimatedCostUsd": 0.005931,
    "inputTokens": 42,
    "estimatedOutputTokens": 21,
    "recommendedModel": "claude-haiku-4-5-20251001",
    "alternativeCosts": {
      "claude-haiku-4-5-20251001": 0.000118,
      "claude-sonnet-4-6": 0.000441,
      "claude-opus-4-6": 0.002205
    },
    "policyStatus": "allow",
    "violations": []
  }
}
```

---

### `GET /api/v1/usage/:apiKey` — Per-Key Analytics

```bash
curl http://localhost:3100/api/v1/usage/your-api-key
```

**Response:**
```json
{
  "success": true,
  "data": {
    "apiKey": "your-api-key",
    "period": "since 2026-04-04T12:00:00.000Z",
    "totalRequests": 147,
    "totalInputTokens": 284500,
    "totalOutputTokens": 98200,
    "totalCostUsd": 1.234567,
    "totalSavingsUsd": 0.456789,
    "cacheHitRate": 0.23,
    "modelBreakdown": {
      "claude-haiku-4-5-20251001": 89,
      "claude-sonnet-4-6": 52,
      "claude-opus-4-6": 6
    }
  }
}
```

Optional query parameter: `?since=1712188800000` (Unix timestamp in ms).

---

### `GET /api/v1/usage` — Global Analytics

Returns aggregated usage across all API keys.

---

### `GET /api/v1/budget/:apiKey` — Budget Status

```bash
curl http://localhost:3100/api/v1/budget/your-api-key
```

**Response:**
```json
{
  "success": true,
  "data": {
    "spent": 12.45,
    "remaining": 37.55,
    "dailyLimit": 50.00
  }
}
```

---

### `GET /api/v1/models` — Available Models & Pricing

```bash
curl http://localhost:3100/api/v1/models
```

---

### `GET /api/v1/cache/stats` — Cache Performance

```json
{
  "success": true,
  "data": {
    "hits": 234,
    "misses": 891,
    "hitRate": 0.208,
    "size": 234
  }
}
```

---

### `DELETE /api/v1/cache` — Clear Cache

```bash
curl -X DELETE http://localhost:3100/api/v1/cache
```

---

### `GET /api/v1/recent` — Recent Request Log

```bash
curl http://localhost:3100/api/v1/recent?limit=20
```

Returns the last N processed requests with full metadata.

---

### `GET /api/v1/health` — Health Check

```bash
curl http://localhost:3100/api/v1/health
```

---

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Server port |
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `ANTHROPIC_API_KEY` | — | **Required.** Your Anthropic API key |
| `REDIS_ENABLED` | `false` | Enable Redis for shared caching |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `CACHE_TTL_SECONDS` | `3600` | Cache entry time-to-live (1 hour) |
| `CACHE_MAX_SIZE` | `10000` | Max entries in memory cache |
| `DEFAULT_MAX_TOKENS_PER_REQUEST` | `100000` | Max input tokens per request |
| `DEFAULT_MAX_OUTPUT_TOKENS` | `4096` | Max output tokens cap |
| `DEFAULT_BUDGET_PER_KEY_DAILY_USD` | `50.00` | Daily spend limit per API key |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Default model when none specified |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `AUTO_SUMMARIZE_THRESHOLD_TOKENS` | `50000` | Token count that triggers context trimming |
| `DEDUP_WINDOW_SECONDS` | `300` | Dedup detection window |
| `PROMPT_TRIM_ENABLED` | `true` | Enable automatic prompt trimming |

---

## How Quota Saves Money

### 1. Smart Model Routing

A "translate hello to French" request doesn't need Opus ($15/1M input). Quota classifies task complexity and routes to the cheapest capable model:

| Task | Without Quota | With Quota | Savings |
|---|---|---|---|
| Simple classification | Opus: $0.015 | Haiku: $0.0008 | **94.7%** |
| Code review | Opus: $0.015 | Sonnet: $0.003 | **80.0%** |
| Complex architecture | Opus: $0.015 | Opus: $0.015 | 0% (correct model) |

### 2. Response Caching

Repeated identical requests return cached responses at **zero cost**. Common in:
- Chatbots with templated greetings
- CI/CD pipelines running the same code review prompts
- Internal tools with standard queries

### 3. Prompt Optimization

Before sending to Claude, Quota automatically:
- Normalizes whitespace (collapsed spaces, trimmed lines)
- Removes consecutive duplicate messages
- Trims oldest messages when context exceeds thresholds
- Compresses verbose system prompts

Typical savings: **5-15% token reduction** per request.

### 4. Budget Enforcement

Requests that would exceed the daily budget are **blocked before execution** — you never get a surprise bill.

---

## Pipeline Flow

Every request passes through these stages in order:

```
1. VALIDATE    → Zod schema validation on the incoming request
2. ANALYZE     → Token counting, complexity classification, fingerprinting
3. ESTIMATE    → Cost calculation across all models
4. CACHE CHECK → Return cached response if available (skip steps 5-8)
5. POLICY      → Budget check, token limits, model restrictions
6. OPTIMIZE    → Whitespace, dedup, trimming, compression
7. ROUTE       → Select cheapest capable model
8. EXECUTE     → Call Claude API (with retries)
9. CACHE STORE → Save response for future identical requests
10. LOG        → Record usage, cost, savings to analytics
```

If a request is blocked by policy at step 5, no API call is made and no cost is incurred.

---

## Running Tests

```bash
npm test
```

Runs 21 tests across 5 suites:

- **Analyzer** — complexity classification, fingerprinting, token counting
- **Estimator** — cost calculation, multi-model comparison
- **Policy** — budget enforcement, token limits, model restrictions
- **Optimizer** — whitespace normalization, dedup, trimming
- **Router** — model selection logic, budget pressure handling

```bash
npm test -- --coverage    # With coverage report
```

---

## Docker Deployment

### Development (no Redis)

```bash
docker build -t quota .
docker run -p 3100:3100 -e ANTHROPIC_API_KEY=sk-ant-xxx quota
```

### Production (with Redis)

```bash
ANTHROPIC_API_KEY=sk-ant-xxx docker-compose up --build -d
```

This starts:
- `quota-api` on port 3100
- `quota-redis` on port 6379 (with append-only persistence and 256MB LRU eviction)

---

## Scaling for Production

### Horizontal Scaling

Quota is stateless by design. Run N instances behind a load balancer:

```
                   ┌──── Quota Instance 1 ────┐
Load Balancer ─────┼──── Quota Instance 2 ────┼──── Redis (shared cache + budget state)
                   └──── Quota Instance 3 ────┘
```

Enable `REDIS_ENABLED=true` so all instances share:
- Response cache (avoid duplicate API calls across instances)
- Rate limiting state (shared counters)

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: quota
spec:
  replicas: 3
  selector:
    matchLabels:
      app: quota
  template:
    metadata:
      labels:
        app: quota
    spec:
      containers:
        - name: quota
          image: quota:latest
          ports:
            - containerPort: 3100
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: quota-secrets
                  key: anthropic-api-key
            - name: REDIS_ENABLED
              value: "true"
            - name: REDIS_URL
              value: "redis://redis-service:6379"
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /api/v1/health
              port: 3100
            initialDelaySeconds: 10
          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: 3100
            initialDelaySeconds: 5
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: quota-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: quota
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Further Scaling Recommendations

- **Persistent budget tracking**: Replace in-memory budget maps with Redis TTL keys for cross-instance accuracy
- **Analytics pipeline**: Export usage records to InfluxDB/TimescaleDB/BigQuery for long-term analysis
- **Queue-based batching**: Add BullMQ for low-priority batch processing during off-peak hours
- **Observability**: Pipe Pino JSON logs to ELK/Datadog/Grafana, add Prometheus metrics endpoint
- **Multi-region**: Deploy in multiple regions with regional Redis replicas for low-latency cache hits

---

## Project Structure

```
Quota/
├── src/
│   ├── index.ts                 # Server entry point
│   ├── types/index.ts           # All TypeScript types, enums, Zod schemas
│   ├── config/index.ts          # Environment-based configuration
│   ├── analyzer/index.ts        # Request analysis + complexity classification
│   ├── estimator/index.ts       # Pre-execution cost estimation
│   ├── policy/index.ts          # Budget + token + model policy enforcement
│   ├── optimizer/index.ts       # Prompt optimization (trim, dedup, compress)
│   ├── router/index.ts          # Smart model selection
│   ├── executor/index.ts        # Claude API execution with retries
│   ├── cache/index.ts           # Redis + in-memory LRU cache
│   ├── logging/index.ts         # Usage analytics + savings tracking
│   ├── gateway/
│   │   ├── index.ts             # Gateway exports
│   │   ├── pipeline.ts          # Request pipeline orchestrator
│   │   └── routes.ts            # REST API route definitions
│   ├── middleware/
│   │   ├── rateLimiter.ts       # Per-key rate limiting
│   │   └── requestLogger.ts     # HTTP request logging
│   └── utils/
│       ├── logger.ts            # Structured logging (Pino)
│       └── tokenizer.ts         # Token counting (tiktoken)
├── tests/
│   ├── analyzer.test.ts
│   ├── estimator.test.ts
│   ├── policy.test.ts
│   ├── optimizer.test.ts
│   └── router.test.ts
├── Dockerfile                   # Multi-stage production build
├── docker-compose.yml           # Quota + Redis stack
├── package.json
├── tsconfig.json
├── jest.config.js
├── .env.example
├── .gitignore
└── .dockerignore
```

---

## License

MIT

---

Built with [Claude Code](https://claude.ai/claude-code)
