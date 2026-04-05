# How Quota Works — A Deep Dive

Quota is a **deterministic proxy layer** — not an AI engine. It uses math, heuristics, string manipulation, and caching to control and reduce your AI spending. The only AI involved is the single Claude API call at the end, which is the exact call Quota exists to protect you from making wastefully.

This document explains every stage of the pipeline, what technology powers it, and why none of it requires AI.

---

## The Core Principle

```
Your App  →  Quota (no AI — pure logic)  →  Claude API (the one AI call)
```

Quota sits between your application and the Claude API. Every request passes through a **10-stage pipeline** of deterministic checks and transformations. By the time a request actually reaches Claude, it has been:

- Analyzed for token count and complexity
- Cost-estimated across all available models
- Checked against budget and policy rules
- Optimized to use fewer tokens
- Routed to the cheapest capable model
- Checked against the cache for a free instant response

If any stage determines the request should be blocked (over budget, too many tokens, restricted model), **no API call is made and zero cost is incurred**.

---

## The 10-Stage Pipeline

Every single request flows through these stages in order. Here is exactly what happens at each stage, how it works under the hood, and why none of it uses AI.

---

### Stage 1: Validate

**What it does:** Checks that the incoming HTTP request has the correct structure — valid JSON, required fields present, correct data types.

**How it works:** Uses [Zod](https://zod.dev/), a TypeScript schema validation library. The request body is validated against a predefined schema that specifies:
- `apiKey` must be a non-empty string
- `messages` must be an array of objects with `role` ("user" or "assistant") and `content` (string)
- `model`, `system`, `maxTokens`, `temperature` are optional with type constraints

**Technology:** Zod schema validation — pattern matching and type checking. No AI.

**What happens on failure:** Returns a 400 error with specific field-level error messages. The request never enters the pipeline.

```
Input:  { "messages": [] }
Output: 400 — "At least one message is required"
```

---

### Stage 2: Analyze

**What it does:** Examines the request to understand its characteristics — how many tokens, how complex is the task, what's the conversation structure.

**How it works:** Three operations run in sequence:

**Token Counting** — Uses the `tiktoken` library with the `cl100k_base` encoding (the same tokenizer family used by large language models). This is a deterministic byte-pair encoding algorithm that splits text into tokens using a fixed vocabulary table. Every run produces the exact same count for the same input. If tiktoken fails to load, it falls back to a `characters / 4` heuristic (roughly 4 characters per English token).

**Complexity Classification** — A scoring system based on simple rules:

| Signal | Score Change |
|---|---|
| Prompt contains "analyze", "implement", "architect", "debug", "refactor" | +2 |
| Prompt contains "translate", "classify", "format", "yes or no" | -2 |
| Total tokens > 10,000 | +2 |
| Total tokens > 3,000 | +1 |
| Total tokens < 500 | -1 |
| More than 6 messages in conversation | +1 |
| More than 12 messages | +1 |
| Last user message longer than 2,000 characters | +1 |

Final classification:
- Score >= 3 → **Complex** (needs Opus)
- Score >= 1 → **Moderate** (needs Sonnet)
- Score < 1 → **Simple** (Haiku is fine)

This is a keyword lookup + arithmetic scoring heuristic. No AI, no machine learning, no neural network — just `if/else` and addition.

**Content Fingerprinting** — Serializes the messages and system prompt to JSON, then runs SHA-256 hashing to produce a 16-character fingerprint. Used later by the cache layer for exact-match deduplication. SHA-256 is a cryptographic hash function — pure mathematics.

**Technology:** Byte-pair encoding tokenizer, keyword matching, integer arithmetic, SHA-256 hashing. No AI.

---

### Stage 3: Estimate

**What it does:** Calculates the estimated cost of the request in USD across all available Claude models — **before any money is spent**.

**How it works:** Simple multiplication using Anthropic's published pricing:

```
Input Cost  = (input_tokens / 1,000,000) × input_price_per_1M
Output Cost = (estimated_output_tokens / 1,000,000) × output_price_per_1M
Total Cost  = Input Cost + Output Cost
```

This calculation is performed for every model:

| Model | Input per 1M Tokens | Output per 1M Tokens |
|---|---|---|
| Claude Haiku 4.5 | $0.80 | $4.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Opus 4.6 | $15.00 | $75.00 |

Output tokens are estimated as ~50% of input tokens (capped at `maxTokens`). This is a conservative heuristic based on typical response patterns.

**Example:** A request with 1,000 input tokens and an estimated 500 output tokens:
- Haiku: (1000/1M × $0.80) + (500/1M × $4.00) = $0.0008 + $0.002 = **$0.0028**
- Sonnet: (1000/1M × $3.00) + (500/1M × $15.00) = $0.003 + $0.0075 = **$0.0105**
- Opus: (1000/1M × $15.00) + (500/1M × $75.00) = $0.015 + $0.0375 = **$0.0525**

**Technology:** Multiplication and division. No AI.

---

### Stage 4: Cache Check

**What it does:** Looks up the request in the cache. If an identical request was processed before and the cached response hasn't expired, return it immediately — **zero cost, near-zero latency**.

**How it works:** 

1. Generates a cache key by hashing the request's content-affecting fields: `SHA-256(model + messages + system + temperature)`
2. Looks up the key in the cache backend:
   - **Redis** (production) — shared across all Quota instances
   - **In-memory LRU** (development) — local to the process, max 10,000 entries
3. If found and not expired (TTL default: 1 hour), return the cached response
4. If not found, continue to Stage 5

**Why this works:** Many real-world AI usage patterns involve repeated identical requests:
- Chatbots with standard greetings
- CI/CD pipelines running the same code review prompts
- Internal tools where multiple users ask the same question
- Retry logic that re-sends failed requests

**Technology:** SHA-256 hashing, key-value lookup (Redis or LRU cache), TTL-based expiration. No AI.

**On cache hit:** Stages 5-8 are completely skipped. The response is returned directly from cache, analytics are recorded with `cached: true`, and the cost is $0.00.

---

### Stage 5: Policy

**What it does:** Enforces rules to prevent overspending, oversized requests, and unauthorized model usage. Can **allow**, **modify**, or **block** requests.

**How it works:** Four rules are evaluated in order:

**Rule 1 — Token Limit Per Request:**
```
if (input_tokens > max_tokens_per_request) → BLOCK
```
Default limit: 100,000 tokens. Prevents accidentally sending massive context windows.

**Rule 2 — Output Token Cap:**
```
if (requested_max_tokens > max_output_tokens) → MODIFY (reduce to cap)
```
Default cap: 4,096 tokens. If the caller requests 50,000 output tokens, Quota silently reduces it to 4,096.

**Rule 3 — Model Restrictions:**
```
if (requested_model not in allowed_models) → BLOCK
```
By default all models are allowed. Configurable to restrict teams to cheaper models only.

**Rule 4 — Daily Budget Per API Key:**
```
if (estimated_cost > remaining_daily_budget) → BLOCK
```
Tracks cumulative spend per API key per day. Default: $50/day per key. Resets at midnight UTC.

**Budget tracking implementation:** An in-memory `Map<string, number>` keyed by `apiKeyPrefix:YYYY-MM-DD`. After each successful API call, the actual cost is added. Before each new call, remaining budget is checked. Production deployments should use Redis for cross-instance consistency.

**Technology:** Comparison operators (`>`, `<`), `Map` data structure, date formatting. No AI.

**On block:** Returns a 403 response with the specific violation(s). No API call is made. The estimated cost is recorded as "savings" in analytics.

---

### Stage 6: Optimize

**What it does:** Reduces token count by cleaning up the request — saving money on every API call.

**How it works:** Four optimization strategies applied in order:

**Strategy 1 — Whitespace Normalization:**
```
"Hello    world   with    extra    spaces"  →  "Hello world with extra spaces"
```
Collapses multiple spaces/tabs to single space. Collapses 3+ consecutive newlines to 2. Trims leading/trailing whitespace. Uses regex: `/[ \t]+/g` → `' '` and `/\n{3,}/g` → `'\n\n'`.

**Strategy 2 — Message Deduplication:**
Removes consecutive identical messages (same role + same content). Common when frontends accidentally double-send messages or retry logic duplicates conversation history.
```
[user: "Hello", user: "Hello", assistant: "Hi"]  →  [user: "Hello", assistant: "Hi"]
```
Simple array iteration comparing adjacent elements.

**Strategy 3 — Context Trimming:**
If the total token count exceeds the auto-summarize threshold (default: 50,000 tokens), drop the oldest messages while preserving at minimum the last 4 messages (2 conversation turns). This prevents bloated conversation histories from inflating costs.
```
while (tokens > threshold && messages.length > 4) {
  messages.shift()  // remove oldest
}
```

**Strategy 4 — System Prompt Compression:**
If the system prompt exceeds 2,000 tokens, strip markdown formatting that doesn't affect the instruction's meaning:
- Remove markdown headers (`## `, `### `, `#### `)
- Remove horizontal rules (`---`, `===`)
- Collapse excessive blank lines
- Trim trailing whitespace on each line

The actual instruction text is preserved. Only formatting chrome is removed.

**Token savings tracking:** Before and after token counts are compared. The difference is reported in the response's `meta.optimizations` array.

**Technology:** Regex string replacement, array iteration, character counting. No AI.

---

### Stage 7: Route

**What it does:** Selects the cheapest Claude model that can handle the task at the required quality level.

**How it works:** A lookup table maps task complexity (from Stage 2) to the minimum model tier:

| Complexity | Minimum Tier | Cheapest Capable Model |
|---|---|---|
| Simple | 1 | Haiku ($0.80/1M input) |
| Moderate | 2 | Sonnet ($3.00/1M input) |
| Complex | 3 | Opus ($15.00/1M input) |

**Routing logic:**
1. If the caller explicitly specified a model → use it (respect the caller's choice)
2. Otherwise, iterate models from cheapest to most expensive. Pick the first one that:
   - Meets the minimum capability tier for the task complexity
   - Fits within the remaining budget
3. **Budget pressure:** If remaining daily budget is < 5× the estimated cost, automatically downgrade one tier (e.g., Sonnet → Haiku) to stretch the budget further

**Why this saves money:** A "translate hello to French" request doesn't need Opus ($15/1M). Quota routes it to Haiku ($0.80/1M) — that's a **94.7% cost reduction** with no quality loss for simple tasks.

| Task | Without Quota (Opus default) | With Quota (auto-routed) | Savings |
|---|---|---|---|
| "Translate hello to French" | $0.0150 | $0.0008 (Haiku) | 94.7% |
| "Review this code for bugs" | $0.0150 | $0.0030 (Sonnet) | 80.0% |
| "Design a distributed system" | $0.0150 | $0.0150 (Opus) | 0% — correct model |

**Technology:** Array iteration, integer comparison, lookup table. No AI.

---

### Stage 8: Execute

**What it does:** Makes the actual Claude API call. This is the **only stage that involves AI** — and it's the Anthropic Claude API, not Quota itself.

**How it works:**
1. Constructs the API request with the optimized messages, selected model, and parameters
2. Calls `anthropic.messages.create()` via the official Anthropic SDK
3. On success: extracts the text response, actual token counts, and calculates real cost
4. On failure: retries with exponential backoff

**Retry policy:**
- 3 attempts maximum
- Backoff: 1s → 2s → 4s between attempts
- Retries on: 429 (rate limit), 500/502/503 (server errors)
- Does NOT retry on: 400 (bad request), 401 (auth failure), 404

**Actual cost calculation** (from real token counts returned by Claude):
```
actual_cost = (actual_input_tokens / 1M × input_rate) + (actual_output_tokens / 1M × output_rate)
```

**Technology:** HTTP client (Anthropic SDK), exponential backoff (setTimeout), arithmetic. The AI is in Claude's servers — Quota just makes the HTTP call.

---

### Stage 9: Cache Store

**What it does:** Saves the response so future identical requests can be served from cache at zero cost.

**How it works:**
1. Uses the same cache key generated in Stage 4
2. Stores the full response (content, model, token counts, cost) in both:
   - In-memory LRU cache (always)
   - Redis with TTL expiration (if enabled)
3. The response is evicted automatically when the TTL expires (default: 1 hour) or when the LRU cache reaches capacity (default: 10,000 entries, oldest-accessed evicted first)

**Also at this stage:** The actual cost is recorded in the policy engine's budget tracker via `policy.recordSpend(apiKey, actualCost)`.

**Technology:** Key-value store (Redis SET/GET), LRU eviction algorithm, TTL timers. No AI.

---

### Stage 10: Log

**What it does:** Records the complete request lifecycle for analytics, reporting, and debugging.

**What gets recorded:**

```json
{
  "requestId": "uuid",
  "apiKey": "the-key",
  "timestamp": 1712188800000,
  "model": "claude-haiku-4-5-20251001",
  "inputTokens": 42,
  "outputTokens": 187,
  "estimatedCostUsd": 0.0052,
  "actualCostUsd": 0.0031,
  "savingsUsd": 0.0021,
  "cached": false,
  "optimizations": ["whitespace_normalization(-8 tokens)"],
  "latencyMs": 1847
}
```

**Savings calculation:**
- **Cache hit:** savings = full estimated cost (100% saved)
- **Model routing:** savings = (original model cost) - (routed model cost)
- **Token optimization:** savings = (tokens saved) × (token rate)

Records are stored in memory (up to 100,000), indexed by API key for fast per-key lookups. Production deployments should pipe these to a time-series database (InfluxDB, TimescaleDB) or data warehouse (BigQuery, Redshift).

**Technology:** Array push, Map indexing, arithmetic aggregation. No AI.

---

## Summary: What Uses AI and What Doesn't

| Stage | Uses AI? | Technology |
|---|---|---|
| 1. Validate | No | Zod schema validation |
| 2. Analyze | No | Tiktoken (byte-pair encoding), keyword matching, SHA-256 |
| 3. Estimate | No | Multiplication (tokens × price) |
| 4. Cache Check | No | SHA-256 hashing, Redis/LRU key-value lookup |
| 5. Policy | No | Comparison operators, Map data structure |
| 6. Optimize | No | Regex, array dedup, string trimming |
| 7. Route | No | Lookup table, array iteration |
| **8. Execute** | **Yes — Claude API** | **Anthropic SDK HTTP call (the one AI call)** |
| 9. Cache Store | No | Redis SET, LRU cache insert |
| 10. Log | No | Array accumulation, arithmetic |

**9 out of 10 stages are pure deterministic code.** The only AI involvement is the Claude API call in Stage 8, which is the call your application would have made anyway. Quota just ensures that call is as cheap, necessary, and optimized as possible before it happens.

---

## How to Test Each Stage

You can verify Quota's behavior without spending any money on AI calls.

### Test Stages 1-5 and 7 (no API key needed):

The `/preview` endpoint runs stages 1-3, 5, and 7 without executing:

```bash
curl -X POST http://localhost:3100/api/v1/preview \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "test-key",
    "messages": [{"role": "user", "content": "Translate hello to French"}]
  }'
```

Response shows: token count (Stage 2), cost estimate (Stage 3), policy status (Stage 5), recommended model (Stage 7).

### Test Policy Blocking (no API key needed):

```bash
curl -X POST http://localhost:3100/api/v1/preview \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "test-key",
    "messages": [{"role": "user", "content": "Hello"}],
    "maxTokens": 999999
  }'
```

### Test the Full Pipeline (requires API key):

```bash
# First request — goes through all 10 stages
curl -X POST http://localhost:3100/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "test-key",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'

# Same request again — Stage 4 cache hit, stages 5-8 skipped
curl -X POST http://localhost:3100/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "test-key",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

The second request should return with `"cached": true` and `"actualCostUsd": 0`.

### Test Analytics (no API key needed):

```bash
curl http://localhost:3100/api/v1/usage/test-key
curl http://localhost:3100/api/v1/budget/test-key
curl http://localhost:3100/api/v1/cache/stats
```

### Run Unit Tests (no API key needed):

```bash
npm test
```

21 tests validate the core logic of Stages 2, 3, 5, 6, and 7 without making any API calls.

---

## The Bottom Line

Quota is a **rules engine with a pricing calculator and a cache**. It does not use AI to analyze your prompts, estimate costs, enforce policies, optimize tokens, or route models. It uses the same kind of logic that powers rate limiters, API gateways, and CDN caches — battle-tested, deterministic, and predictable.

The only AI call is the one you intended to make. Quota just makes sure it's the right call, at the right price, with the right model.
