// oauth.ts — STATELESS OAuth 2.0 layer for MCP (so the ChatGPT app / Claude web can
// connect — they only support OAuth and have no field to paste an API key).
//
// The MCP server acts as both Authorization Server + Protected Resource. The user
// "signs in" by PASTING the project's API KEY at /mcp-oauth/authorize → if valid
// (verified via /ext/me) → we issue an access token = AES-256-GCM wrapping the api key.
// Nothing is stored server-side (stateless); tokens survive restarts. Revoke/expire
// still applies because every request ultimately calls the backend with the wrapped key.
//
// Security: PKCE S256 required, single-use codes with a short TTL, redirect_uri
// allowlist, authenticated-encryption tokens (GCM), TLS at the reverse proxy, no key/secret logging.
import type { Express, Response } from 'express'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ApiClient } from './apiClient.js'
import type { Config } from './config.js'
import { logInfo } from './audit.js'

const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000

// Hosts allowed to receive the redirect (prevents authorization-code theft). Add your client host if needed.
const ALLOWED_REDIRECT_SUFFIXES = ['chatgpt.com', 'openai.com', 'claude.ai', 'anthropic.com']
function isAllowedRedirect(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true
  if (u.protocol !== 'https:') return false
  return ALLOWED_REDIRECT_SUFFIXES.some(d => u.hostname === d || u.hostname.endsWith('.' + d))
}

function enc(secretKey: Buffer, obj: unknown): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', secretKey, iv)
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')
}
function dec<T = any>(secretKey: Buffer, token: string): T | null {
  try {
    const raw = Buffer.from(token, 'base64url')
    if (raw.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', secretKey, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as T
  } catch { return null }
}
const s256b64url = (v: string) => createHash('sha256').update(v).digest('base64url')

export interface OAuth {
  resolveAccessToken(token: string): string | null
  resourceMetadataUrl: string
}

export function registerOAuth(app: Express, cfg: Config): OAuth {
  const secretKey = createHash('sha256').update(cfg.oauthSecret!).digest()
  const issuer = cfg.publicUrl!.replace(/\/+$/, '')
  const authorizeUrl = `${issuer}/mcp-oauth/authorize`
  const tokenUrl = `${issuer}/mcp-oauth/token`
  const registerUrl = `${issuer}/mcp-oauth/register`
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`

  const cors = (res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }

  // Per-IP rate limit for the OAuth POST endpoints (authorize/token) — stops the
  // authorize page being used as an API-key brute oracle + /token flood.
  const OAUTH_RATE = 20, OAUTH_WINDOW_MS = 60_000
  const buckets = new Map<string, { tokens: number; ts: number }>()
  function rateOk(ip: string): boolean {
    const now = Date.now()
    let b = buckets.get(ip)
    if (!b) { b = { tokens: OAUTH_RATE, ts: now }; buckets.set(ip, b) }
    b.tokens = Math.min(OAUTH_RATE, b.tokens + ((now - b.ts) / OAUTH_WINDOW_MS) * OAUTH_RATE)
    b.ts = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
  // Single-use authorization codes (best-effort in-memory) — reject code replay
  // within the TTL by remembering the code nonce `n` (OAuth 2.1).
  const usedCodes = new Map<string, number>() // nonce → expiry
  setInterval(() => {
    const now = Date.now()
    for (const [n, exp] of usedCodes) if (now > exp) usedCodes.delete(n)
    if (buckets.size > 10_000) buckets.clear()
  }, 60_000).unref?.()

  const asMeta = {
    issuer, authorization_endpoint: authorizeUrl, token_endpoint: tokenUrl, registration_endpoint: registerUrl,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  }
  const prMeta = {
    resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ['mcp'], bearer_methods_supported: ['header'],
  }
  app.get(/^\/\.well-known\/oauth-authorization-server(\/.*)?$/, (_q, res) => { cors(res); res.json(asMeta) })
  app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (_q, res) => { cors(res); res.json(prMeta) })
  app.options(/^\/\.well-known\/oauth-.*$/, (_q, res) => { cors(res); res.status(204).end() })

  app.options('/mcp-oauth/register', (_q, res) => { cors(res); res.status(204).end() })
  app.post('/mcp-oauth/register', (req, res) => {
    cors(res)
    const b = (req.body ?? {}) as Record<string, unknown>
    res.status(201).json({
      client_id: 'mcpc_' + randomUUID().replace(/-/g, ''), client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: Array.isArray(b.redirect_uris) ? b.redirect_uris : [],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      client_name: typeof b.client_name === 'string' ? b.client_name : 'MCP Client',
    })
  })

  app.get('/mcp-oauth/authorize', (req, res) => {
    const q = req.query as Record<string, string>
    const err = validate(q)
    if (err) { res.status(400).send(pageError(err)); return }
    res.status(200).type('html').send(pageForm(q, null))
  })
  app.post('/mcp-oauth/authorize', async (req, res) => {
    if (!rateOk(req.ip || 'unknown')) {
      res.setHeader('Retry-After', '60')
      res.status(429).type('html').send(pageError('Too many requests, try again in a minute.'))
      return
    }
    const b = (req.body ?? {}) as Record<string, string>
    const err = validate(b)
    if (err) { res.status(400).send(pageError(err)); return }
    const apiKey = (b.api_key || '').trim()
    if (cfg.keyPrefix && !apiKey.startsWith(cfg.keyPrefix)) {
      res.status(200).type('html').send(pageForm(b, `API key must start with "${cfg.keyPrefix}".`)); return
    }
    const client = new ApiClient({ apiBase: cfg.apiBase, apiKey, timeoutMs: cfg.timeoutMs })
    try { await client.get('/ext/me') }
    catch { res.status(200).type('html').send(pageForm(b, 'API key is invalid / revoked / expired.')); return }
    const code = enc(secretKey, { k: apiKey, cc: b.code_challenge, ru: b.redirect_uri, exp: Date.now() + CODE_TTL_MS, n: randomBytes(6).toString('hex'), t: 'code' })
    const to = new URL(b.redirect_uri)
    to.searchParams.set('code', code)
    if (b.state) to.searchParams.set('state', b.state)
    res.redirect(302, to.toString())
  })

  app.options('/mcp-oauth/token', (_q, res) => { cors(res); res.status(204).end() })
  app.post('/mcp-oauth/token', (req, res) => {
    cors(res)
    if (!rateOk(req.ip || 'unknown')) {
      res.setHeader('Retry-After', '60')
      res.status(429).json({ error: 'temporarily_unavailable', error_description: 'rate limited' }); return
    }
    const b = (req.body ?? {}) as Record<string, string>
    if (b.grant_type === 'authorization_code') {
      const p = dec<any>(secretKey, b.code || '')
      if (!p || p.t !== 'code' || Date.now() > p.exp) { res.status(400).json({ error: 'invalid_grant', error_description: 'code invalid/expired' }); return }
      if (p.ru !== b.redirect_uri) { res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }); return }
      const expected = p.cc || '', got = s256b64url(b.code_verifier || '')
      if (!expected || expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE invalid' }); return
      }
      // Single-use: a code (nonce n) can be exchanged only once within its TTL (OAuth 2.1).
      if (!p.n || usedCodes.has(p.n)) { res.status(400).json({ error: 'invalid_grant', error_description: 'code already used' }); return }
      usedCodes.set(p.n, p.exp)
      res.json(issue(p.k)); return
    }
    if (b.grant_type === 'refresh_token') {
      const p = dec<any>(secretKey, b.refresh_token || '')
      if (!p || p.t !== 'refresh' || Date.now() > p.exp) { res.status(400).json({ error: 'invalid_grant', error_description: 'refresh invalid/expired' }); return }
      res.json(issue(p.k)); return
    }
    res.status(400).json({ error: 'unsupported_grant_type' })
  })

  function issue(apiKey: string) {
    return {
      access_token: enc(secretKey, { k: apiKey, exp: Date.now() + ACCESS_TTL_MS, t: 'access' }),
      token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: enc(secretKey, { k: apiKey, exp: Date.now() + REFRESH_TTL_MS, t: 'refresh' }), scope: 'mcp',
    }
  }

  logInfo(`OAuth enabled — issuer ${issuer}`)
  return {
    resourceMetadataUrl,
    resolveAccessToken(token: string): string | null {
      const p = dec<any>(secretKey, token)
      if (!p || p.t !== 'access' || Date.now() > p.exp || typeof p.k !== 'string') return null
      if (cfg.keyPrefix && !p.k.startsWith(cfg.keyPrefix)) return null
      return p.k
    },
  }
}

function validate(q: Record<string, string>): string | null {
  if (q.response_type !== 'code') return 'response_type must be "code".'
  if (!q.redirect_uri) return 'missing redirect_uri.'
  if (!isAllowedRedirect(q.redirect_uri)) return 'redirect_uri is not in the allowlist.'
  if (!q.code_challenge) return 'missing code_challenge (PKCE required).'
  if ((q.code_challenge_method || 'plain') !== 'S256') return 'only PKCE S256 is supported.'
  return null
}

const esc = (s?: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const hidden = (q: Record<string, string>, n: string) => q[n] ? `<input type="hidden" name="${n}" value="${esc(q[n])}">` : ''
function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0b0f17;color:#e6edf3;padding:24px}.card{width:100%;max-width:420px;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px}h1{font-size:19px;margin:0 0 6px}p{color:#9ca3af;margin:0 0 18px;font-size:13.5px}label{display:block;font-size:13px;margin:0 0 6px;color:#cbd5e1}input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#e6edf3;font-size:14px}button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#1d4ed8}.err{background:#3f1d1d;border:1px solid #7f1d1d;color:#fecaca;padding:10px 12px;border-radius:10px;font-size:13px;margin:0 0 14px}.hint{margin-top:14px;font-size:12px;color:#6b7280}</style></head><body><div class="card">${inner}</div></body></html>`
}
function pageForm(q: Record<string, string>, error: string | null): string {
  return shell('Connect MCP', `<h1>Connect MCP</h1><p>Paste your API key to authorize the connecting app.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="post" action="/mcp-oauth/authorize">
      ${hidden(q, 'response_type')}${hidden(q, 'client_id')}${hidden(q, 'redirect_uri')}${hidden(q, 'state')}${hidden(q, 'code_challenge')}${hidden(q, 'code_challenge_method')}${hidden(q, 'scope')}${hidden(q, 'resource')}
      <label for="api_key">API key</label>
      <input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="paste key..." autofocus required>
      <button type="submit">Authorize &amp; connect</button>
    </form>
    <div class="hint">The connection's permissions equal this key's scopes. Revoking the key in the admin tab disconnects it immediately.</div>`)
}
function pageError(msg: string): string {
  return shell('Connection error', `<h1>Cannot connect</h1><div class="err">${esc(msg)}</div>`)
}
