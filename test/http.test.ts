import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initBody, keyedHandler, mcpPost, startApp, startBackend, type Backend } from './helpers.js'

const KEY = 'ak_http_key_1', KEY2 = 'ak_http_key_2'
let be: Backend

beforeAll(async () => { be = await startBackend(keyedHandler([KEY, KEY2])) })
afterAll(() => be.close())
beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never) })
afterEach(() => { be.requests.length = 0; vi.restoreAllMocks(); vi.useRealTimers() })

const health = async (url: string) => (await fetch(url + '/health')).json() as Promise<any>
async function openSession(url: string, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) {
  const r = await mcpPost(url + '/mcp', initBody(), headers)
  expect(r.status).toBe(200)
  const sid = r.headers.get('mcp-session-id')!
  expect(sid).toBeTruthy()
  return sid
}

describe('http: auth at initialize', () => {
  let app: Awaited<ReturnType<typeof startApp>>
  beforeAll(async () => { app = await startApp({ apiBase: be.base, keyPrefix: 'ak_' }) })
  afterAll(() => app.close())

  it('When GET /health, Then ok + session count', async () => {
    expect(await health(app.url)).toMatchObject({ ok: true, service: 'mcp-al-mcp', sessions: expect.any(Number) })
  })
  it('Given a non-initialize request without a session, Then 400', async () => {
    const r = await mcpPost(app.url + '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${KEY}` })
    expect(r.status).toBe(400)
  })
  it('Given no key, Then 401 without an OAuth challenge (OAuth off)', async () => {
    const r = await mcpPost(app.url + '/mcp', initBody())
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe(-32001)
    expect(r.headers.get('www-authenticate')).toBeNull()
    expect(be.requests).toHaveLength(0)
  })
  it.each([
    ['wrong prefix', { authorization: 'Bearer zz_http_key_1' }],
    ['malformed scheme', { authorization: `Basic ${KEY}` }],
    ['empty bearer', { authorization: 'Bearer   ' }],
    ['blank x-api-key', { 'x-api-key': '  ' }],
  ])('Given %s, Then 401 and the backend is never called', async (_n, headers) => {
    const r = await mcpPost(app.url + '/mcp', initBody(), headers)
    expect(r.status).toBe(401)
    expect(be.requests).toHaveLength(0)
  })
  it('Given a well-formed key the backend rejects, Then 401 "invalid" without echoing the key', async () => {
    const r = await mcpPost(app.url + '/mcp', initBody(), { authorization: 'Bearer ak_revoked' })
    expect(r.status).toBe(401)
    expect(r.text).not.toContain('ak_revoked')
    expect(be.requests[0]).toMatchObject({ url: '/api/ext/me', auth: 'Bearer ak_revoked' })
  })
  it('Given a valid key (Authorization or x-api-key), Then a session is created', async () => {
    const before = (await health(app.url)).sessions
    await openSession(app.url)
    await openSession(app.url, { 'x-api-key': KEY })
    expect((await health(app.url)).sessions).toBe(before + 2)
  })
})

describe('http: session binding', () => {
  let app: Awaited<ReturnType<typeof startApp>>
  let sid: string
  beforeAll(async () => { app = await startApp({ apiBase: be.base, keyPrefix: 'ak_' }) })
  afterAll(() => app.close())
  beforeEach(async () => { sid = await openSession(app.url) })

  const list = (headers: Record<string, string>) =>
    mcpPost(app.url + '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid, ...headers })

  it('Given the same key, When reusing the session, Then the request is served', async () => {
    const r = await list({ authorization: `Bearer ${KEY}` })
    expect(r.status).toBe(200)
    expect(r.json.result.tools).toHaveLength(6)
  })
  it('Given another valid key, When reusing the session, Then 401 key mismatch', async () => {
    const r = await list({ authorization: `Bearer ${KEY2}` })
    expect(r.status).toBe(401)
    expect(r.json.error.message).toContain('does not match')
  })
  it.each([
    ['no key', {}],
    ['an unresolvable bearer', { authorization: 'Bearer zz_not_a_key' }],
    ['an empty bearer', { authorization: 'Bearer ' }],
  ])('Given %s, When reusing the session, Then 401 (session id alone is not a credential)', async (_n, h) => {
    const r = await list(h as Record<string, string>)
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe(-32001)
    expect(r.headers.get('www-authenticate')).toBeNull()
  })
  it('Given a tool call in the session, Then the backend receives the session key', async () => {
    be.requests.length = 0
    const r = await mcpPost(app.url + '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      { 'mcp-session-id': sid, authorization: `Bearer ${KEY}` })
    expect(r.json.result.isError).toBeFalsy()
    expect(be.requests[0]).toMatchObject({ url: '/api/ext/me', auth: `Bearer ${KEY}` })
  })
  it('Given an unknown session id, Then POST/GET/DELETE return 400', async () => {
    const h = { 'mcp-session-id': 'nope', authorization: `Bearer ${KEY}` }
    expect((await mcpPost(app.url + '/mcp', initBody(), h)).status).toBe(400)
    expect((await fetch(app.url + '/mcp', { headers: h })).status).toBe(400)
    expect((await fetch(app.url + '/mcp', { method: 'DELETE', headers: h })).status).toBe(400)
  })
  it.each([
    ['a mismatching key', { authorization: `Bearer ${KEY2}` }],
    ['no key', {}],
    ['an unresolvable bearer', { authorization: 'Bearer zz_x' }],
  ])('Given GET/DELETE with %s, Then 401 and the session survives', async (_n, extra) => {
    const h = { 'mcp-session-id': sid, ...extra } as Record<string, string>
    expect((await fetch(app.url + '/mcp', { headers: h })).status).toBe(401)
    expect((await fetch(app.url + '/mcp', { method: 'DELETE', headers: h })).status).toBe(401)
    expect((await list({ authorization: `Bearer ${KEY}` })).status).toBe(200)
  })
  it('When DELETE /mcp, Then the session is removed', async () => {
    const before = (await health(app.url)).sessions
    const r = await fetch(app.url + '/mcp', { method: 'DELETE', headers: { 'mcp-session-id': sid, authorization: `Bearer ${KEY}` } })
    expect(r.status).toBe(200)
    expect((await health(app.url)).sessions).toBe(before - 1)
    expect((await list({ authorization: `Bearer ${KEY}` })).status).toBe(400)
  })
})

describe('http: initialize rate limit (per IP)', () => {
  it('Given 30 initializes in a minute from one IP, Then the 31st gets 429 + Retry-After', async () => {
    const app = await startApp({ apiBase: be.base, keyPrefix: 'ak_' })
    try {
      for (let i = 0; i < 30; i++) expect((await mcpPost(app.url + '/mcp', initBody())).status).toBe(401)
      const r = await mcpPost(app.url + '/mcp', initBody(), { authorization: `Bearer ${KEY}` })
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBe('60')
    } finally { await app.close() }
  })
})

describe('http: session TTL + cap (fake clock)', () => {
  it('Given an idle session, When 30+ min pass, Then the sweeper evicts it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() })
    const app = await startApp({ apiBase: be.base, keyPrefix: 'ak_' })
    try {
      const sid = await openSession(app.url)
      vi.advanceTimersByTime(25 * 60 * 1000)
      expect((await health(app.url)).sessions).toBe(1)
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect((await health(app.url)).sessions).toBe(0)
      const r = await mcpPost(app.url + '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid, authorization: `Bearer ${KEY}` })
      expect(r.status).toBe(400)
    } finally { await app.close() }
  })
  it('Given 500 live sessions, When another client initializes, Then 503', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() })
    const app = await startApp({ apiBase: be.base, keyPrefix: 'ak_' })
    try {
      for (let i = 0; i < 500; i++) {
        vi.setSystemTime(Date.now() + 2000) // refill the per-IP init bucket
        await openSession(app.url)
      }
      vi.setSystemTime(Date.now() + 2000)
      const r = await mcpPost(app.url + '/mcp', initBody(), { authorization: `Bearer ${KEY}` })
      expect(r.status).toBe(503)
      expect((await health(app.url)).sessions).toBe(500)
    } finally { await app.close() }
  }, 60_000)
})
