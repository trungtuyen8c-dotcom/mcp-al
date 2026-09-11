// http.ts — Streamable HTTP transport (MCP online). Clients need just a URL + API key
// (header) OR OAuth (ChatGPT app / Claude web). Security: verify-at-init, session
// cap/TTL, per-IP rate limit on the initialize path, key bound to the session.
import express, { type Request, type Response } from 'express'
import { randomUUID, createHash } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { buildServer } from './server.js'
import { ApiClient } from './apiClient.js'
import type { Config } from './config.js'
import { logInfo } from './audit.js'
import { registerOAuth, type OAuth } from './oauth.js'

interface Session { transport: StreamableHTTPServerTransport; server: McpServer; keyHash: string; lastSeen: number }
const MAX_SESSIONS = 500, IDLE_MS = 30 * 60 * 1000, INIT_RATE = 30, INIT_WINDOW_MS = 60 * 1000
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
function bearer(req: Request): string | null {
  const h = req.headers['authorization']; if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim()
  const x = req.headers['x-api-key']; return typeof x === 'string' && x.trim() ? x.trim() : null
}

export async function startHttp(cfg: Config) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' })) // /token, /authorize form

  const oauth: OAuth | null = cfg.oauthSecret && cfg.publicUrl ? registerOAuth(app, cfg) : null

  // The bearer may be a raw API key OR an OAuth access token (which wraps the API key).
  function resolveKey(b: string | null): string | null {
    if (!b) return null
    if (!cfg.keyPrefix || b.startsWith(cfg.keyPrefix)) return b
    return oauth ? oauth.resolveAccessToken(b) : null
  }
  const challenge = (res: Response) => { if (oauth) res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${oauth.resourceMetadataUrl}"`) }

  const sessions = new Map<string, Session>()
  const initBuckets = new Map<string, { tokens: number; ts: number }>()
  function initOk(ip: string) {
    const now = Date.now(); let b = initBuckets.get(ip)
    if (!b) { b = { tokens: INIT_RATE, ts: now }; initBuckets.set(ip, b) }
    b.tokens = Math.min(INIT_RATE, b.tokens + ((now - b.ts) / INIT_WINDOW_MS) * INIT_RATE); b.ts = now
    if (b.tokens < 1) return false; b.tokens -= 1; return true
  }
  setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) if (now - s.lastSeen > IDLE_MS) { try { s.transport.close() } catch {} sessions.delete(id) }
    if (initBuckets.size > 10_000) initBuckets.clear()
  }, 5 * 60 * 1000).unref?.()

  app.get('/health', (_q, res) => res.json({ ok: true, service: 'mcp-al-mcp', sessions: sessions.size }))

  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    if (sid && sessions.has(sid)) {
      const s = sessions.get(sid)!
      const rk = resolveKey(bearer(req))
      if (rk && sha256(rk) !== s.keyHash) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'key does not match the session' }, id: null }); return }
      s.lastSeen = Date.now(); await s.transport.handleRequest(req, res, req.body); return
    }
    if (sid || !isInitializeRequest(req.body)) { res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null }); return }
    if (!initOk(req.ip || 'unknown')) { res.setHeader('Retry-After', '60'); res.status(429).json({ jsonrpc: '2.0', error: { code: -32005, message: 'too many initialize requests from this IP' }, id: null }); return }
    const key = resolveKey(bearer(req))
    if (!key) { challenge(res); res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing / invalid API key (or connect via OAuth)' }, id: null }); return }
    if (sessions.size >= MAX_SESSIONS) { res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'max sessions reached' }, id: null }); return }
    const client = new ApiClient({ apiBase: cfg.apiBase, apiKey: key, timeoutMs: cfg.timeoutMs })
    try { await client.get('/ext/me') } catch { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'API key is invalid' }, id: null }); return }
    const keyHash = sha256(key), server = buildServer(client)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, server, keyHash, lastSeen: Date.now() }); logInfo(`session ${id.slice(0, 8)}… (${sessions.size})`) },
    })
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  const withSession = () => async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    if (!sid || !sessions.has(sid)) { res.status(400).send('missing/invalid session'); return }
    const s = sessions.get(sid)!
    const rk = resolveKey(bearer(req))
    if (rk && sha256(rk) !== s.keyHash) { res.status(401).send('key does not match'); return }
    s.lastSeen = Date.now(); await s.transport.handleRequest(req, res)
  }
  app.get('/mcp', withSession())
  app.delete('/mcp', withSession())

  app.listen(cfg.port, () => logInfo(`HTTP MCP :${cfg.port} — POST /mcp`))
}
