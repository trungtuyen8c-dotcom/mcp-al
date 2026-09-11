# Backend API Key System Guide (the "create key" admin tab)

> The skill emits this file when a project's backend does **not yet have** an API-key
> channel. Build this first so the MCP server has something to plug into. The design
> follows the reference system: **hashed** keys (never store plaintext), domain
> **scopes**, super-admin CRUD, a `RequireAPIKey(scope)` middleware, sanitized
> `/ext/*` endpoints + `/ext/me`.
>
> The sample code is **Go + Gin + Postgres**. Other stacks (Node/Nest, Laravel,
> Django, Spring…) follow the same principles — see the mapping table at the end.

Architecture:
```
MCP server ──REST + Authorization: Bearer <key>──▶ /ext/* (RequireAPIKey scope) ──▶ sanitized DTO
```

---

## 1. Key storage table (migration)

Store only the **hash** (SHA-256). Plaintext never touches the DB — it is returned to
the client **exactly once** at creation.

```sql
CREATE TABLE api_keys (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                VARCHAR(120) NOT NULL,
    key_hash            CHAR(64) NOT NULL,          -- SHA-256 hex of the plaintext
    key_prefix          VARCHAR(20) NOT NULL,       -- first few chars, for display only
    scopes              TEXT[] NOT NULL DEFAULT '{}',
    created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    rate_limit          INT NOT NULL DEFAULT 120,   -- requests/minute/key
    last_used_at        TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,                -- NULL = never expires
    revoked_at          TIMESTAMPTZ,                -- soft-revoke, keeps audit trail
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Verify only looks up live keys → partial index on the hash.
CREATE UNIQUE INDEX uq_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
```

---

## 2. Generate & hash the key

- Format: `<prefix>_live_<random>` — e.g. `sk_live_<base64url 24 bytes>` (32 random chars).
- `key_prefix` for display = the "…_live_" part + the first 8 random chars (enough to tell keys apart, without leaking the key).

```go
func genAPIKey(prefix string) (plaintext, keyHash, keyPrefix string, err error) {
    buf := make([]byte, 24)
    if _, err = rand.Read(buf); err != nil { return }
    plaintext = prefix + "_live_" + base64.RawURLEncoding.EncodeToString(buf)
    sum := sha256.Sum256([]byte(plaintext))
    keyHash = hex.EncodeToString(sum[:])
    keyPrefix = plaintext[:min(17, len(plaintext))]
    return
}
```

> Verify = hash the incoming key and look up `key_hash`. Never compare plaintext (there is none).

---

## 3. Scopes — read permissions per domain

One allowlist in a single place. Each scope = one group of data the key may read.

```go
type apiScope struct{ Key, Label, Desc string }
var availableScopes = []apiScope{
    {"items:read",     "Read items",     "Item list + detail (no sensitive fields)"},
    {"orders:read",    "Read orders",    "Orders, statuses, revenue"},
    {"analytics:read", "Read analytics", "Dashboard metrics"},
    // … add scopes per project. To allow writes → add a "*:write" scope and think carefully.
}
func isKnownScope(s string) bool { for _, sc := range availableScopes { if sc.Key == s { return true } }; return false }
```

---

## 4. Key CRUD (super-admin only)

Endpoints:
| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/api-keys` | list (prefix only, NO plaintext) |
| GET | `/admin/api-keys/scopes` | return `availableScopes` for the UI |
| POST | `/admin/api-keys` | create — returns **plaintext once** (`data.plaintext`) |
| PATCH | `/admin/api-keys/:id` | **edit scopes/name/rate/expiry** (never changes the key) |
| DELETE | `/admin/api-keys/:id` | soft-revoke |

Key points:
- **Create**: validate scopes (dedupe, known only, >=1), clamp rate-limit, parse expiry (end of day). Return plaintext **exactly once**.
- **Edit (PATCH)**: only for keys **not revoked**, **never touch key_hash** (clients keep working without reconfiguring), scope changes take effect **immediately** (the middleware reads the DB on every request).
- **Revoke**: `UPDATE … SET revoked_at = NOW()` (keeps history/audit), not a hard delete.

```go
// PATCH — repo:
UPDATE api_keys SET name=$2, scopes=$3, rate_limit=$4, expires_at=$5
WHERE id=$1 AND revoked_at IS NULL
RETURNING …   -- 0 rows → NOT_FOUND
```

---

## 5. `RequireAPIKey(scope)` middleware

Attach it to every `/ext/*` endpoint. Flow: read key → hash → look up (exclude revoked/expired) → **check scope** → **per-key rate limit** → touch last_used → next → audit.

```go
func (h *Handlers) RequireAPIKey(requiredScope string) gin.HandlerFunc {
  return func(c *gin.Context) {
    key := extractKey(c) // "Authorization: Bearer ..." or "X-API-Key: ..."
    if key == "" { c.AbortWithStatusJSON(401, errBody("UNAUTHORIZED","missing API key")); return }
    k, err := h.repo.GetAPIKeyByHash(c, sha256hex(key)) // WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())
    if err != nil { c.AbortWithStatusJSON(401, errBody("UNAUTHORIZED","invalid key")); return }
    if requiredScope != "" && !hasScope(k.Scopes, requiredScope) {
      c.AbortWithStatusJSON(403, errBody("FORBIDDEN","key missing scope: "+requiredScope)); return }
    if !h.rateOkPerKey(c, k.ID, k.RateLimit) { // Redis INCR key rl:apikey:<id> TTL 60s
      c.AbortWithStatusJSON(429, errBody("RATE_LIMITED","rate limit exceeded")); return }
    go h.repo.TouchAPIKeyUsed(context.Background(), k.ID) // throttled to 60s
    c.Set("apiKeyID", k.ID); c.Set("apiKeyScopes", k.Scopes)
    c.Next()
    log.Printf("[ext-audit] key=%q %s %s -> %d", k.Name, c.Request.Method, c.FullPath(), c.Writer.Status())
  }
}
```

Add a **per-IP rate limit BEFORE verify** (e.g. 300/min/IP) to protect the DB from bad-key floods:
```go
ext := r.Group("/api/v1/ext"); ext.Use(h.ExtIPRateLimit())
```

---

## 6. `/ext/*` endpoints — data for the MCP

- Put them under `/api/v1/` so they go through the existing `/api/` reverse proxy (no new proxy).
- A separate group, **NO** JWT auth — only `RequireAPIKey`.
- **Required**: an `/ext/me` (`RequireAPIKey("")`) that returns the key name + scopes → used by the MCP for verify-at-init and OAuth.
- Every handler returns a **sanitized DTO**: drop PII/sensitive fields outside the scope (no passwords, no tokens, no internal links…).

```go
ext.GET("/me",            h.RequireAPIKey(""),             h.Whoami)      // {name, scopes, ok:true}
ext.GET("/items",         h.RequireAPIKey("items:read"),   h.ExtItems)
ext.GET("/items/:id",     h.RequireAPIKey("items:read"),   h.ExtItem)
ext.GET("/orders",        h.RequireAPIKey("orders:read"),  h.ExtOrders)
// … one route here per MCP tool.
```

---

## 7. Admin key-management tab (super-admin)

An OpenAI/Anthropic-style UI:
- **Create API key** button → dialog: name + **scope checkboxes** (from `/scopes`) + expiry (date, empty = never) + rate-limit (empty = default).
- After creation: show the **plaintext once** in a warning box with a Copy button (closing it loses the key).
- Key list: name + status badge (Active/Expired/Revoked) + prefix + scope badges + created/last-used/expiry + rate.
- Per key: an **Edit scopes** button (reopens the dialog, prefilled, calls PATCH) + **Revoke** (with confirm).
- Route + menu visible to `super_admin` only.

API client (JS):
```js
export const apiKeyApi = {
  list:   () => api.get('/admin/api-keys').then(unwrap),
  scopes: () => api.get('/admin/api-keys/scopes').then(unwrap),
  create: (b) => api.post('/admin/api-keys', b).then(unwrap),
  update: (id, b) => api.patch(`/admin/api-keys/${id}`, b).then(unwrap),
  revoke: (id) => api.delete(`/admin/api-keys/${id}`).then(unwrap),
}
```

---

## 8. Acceptance checklist (all green = the MCP can plug in)

```
[ ] api_keys table: hash + key_prefix + scopes[] + rate_limit + expires_at + revoked_at
[ ] Create key: format <prefix>_live_..., returns plaintext EXACTLY once, DB stores only the hash
[ ] Scopes allowlist in one place + GET /scopes
[ ] RequireAPIKey: verify hash → scope (403) → per-key rate limit (429) → touch → audit
[ ] Per-IP rate limit before verify (protects DB from bad-key floods)
[ ] /ext/me returns {name, scopes} — REQUIRED (MCP verify-at-init)
[ ] Every /ext/* returns a sanitized DTO (no PII/secrets outside the scope)
[ ] Super-admin UI: create / edit scopes (PATCH) / revoke + reveal key once
[ ] curl /ext/me: 200 valid key · 401 bad key · 403 wrong scope · 429 over rate · 401 after revoke
```

---

## 9. Mapping to other stacks

| Component | Go/Gin (sample) | Node/Express | Laravel | Django/DRF |
|---|---|---|---|---|
| Hash key | crypto/sha256 | `crypto.createHash('sha256')` | `hash('sha256', …)` | `hashlib.sha256` |
| Scope middleware | `RequireAPIKey()` | header+scope middleware | middleware / Gate | permission class |
| Per-key rate limit | Redis INCR TTL | Redis / rate-limiter-flexible | RateLimiter facade | DRF throttle |
| Table | SQL migration | Prisma/Knex | migration | model + migrate |

**Principles that hold on any stack**: store only the hash · scope allowlist · plaintext
once · soft-revoke · per-key + per-IP rate limits · `/ext/me` · sanitized DTOs.
