import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { startHttp } from '../src/http.js'
import type { Config } from '../src/config.js'

export interface BackendReq { method: string; url: string; auth?: string }
export type Handler = (req: BackendReq) => { status?: number; body?: unknown; raw?: string; delayMs?: number }

// Local fake backend (no network): records every request, answers via a swappable handler.
export async function startBackend(handler: Handler = () => ({ body: { data: { ok: true } } })) {
  const requests: BackendReq[] = []
  let h = handler
  const server = http.createServer((req, res) => {
    const r: BackendReq = { method: req.method!, url: req.url!, auth: req.headers.authorization }
    requests.push(r)
    const out = h(r)
    const send = () => {
      if (res.destroyed) return
      res.statusCode = out.status ?? 200
      res.setHeader('content-type', 'application/json')
      res.end(out.raw ?? JSON.stringify(out.body ?? {}))
    }
    if (out.delayMs) setTimeout(send, out.delayMs)
    else send()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}/api`,
    requests,
    setHandler(n: Handler) { h = n },
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }),
  }
}
export type Backend = Awaited<ReturnType<typeof startBackend>>

// Backend that accepts keys in `valid` on /ext/me and echoes the path otherwise.
export const keyedHandler = (valid: string[]): Handler => (r) => {
  const key = r.auth?.replace(/^Bearer /, '')
  if (!key || !valid.includes(key)) return { status: 401, body: { error: 'invalid key' } }
  return { body: { data: { path: r.url, name: 'test-key' } } }
}

export async function startApp(cfg: Partial<Config> & { apiBase: string }) {
  const server = await startHttp({ timeoutMs: 2000, transport: 'http', port: 0, keyPrefix: '', ...cfg })
  if (!server.listening) await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

export const initBody = (id: number | string = 1) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
})

export async function mcpPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {
    const m = text.match(/^data: (.*)$/m)
    if (m) json = JSON.parse(m[1])
  }
  return { status: r.status, headers: r.headers, json, text }
}

// Re-implements the token format of src/oauth.ts (AES-256-GCM, key = sha256(secret)) to forge tokens.
export function forgeToken(secret: string, payload: unknown): string {
  const key = createHash('sha256').update(secret).digest()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')
}

export const pkce = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
