import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgeToken, initBody, keyedHandler, mcpPost, pkce, startApp, startBackend, type Backend } from './helpers.js'

const KEY = 'ak_oauth_key_1'
const SECRET = 'oauth-secret-0123456789'
const PUBLIC = 'https://mcp.example.com'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'verifier-'.padEnd(64, 'x')
const DAY = 24 * 3600 * 1000

let be: Backend
let app: Awaited<ReturnType<typeof startApp>>

// Fake only Date so each test can refill the per-IP OAuth rate bucket (20/min) by moving the clock.
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  be = await startBackend(keyedHandler([KEY]))
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  app = await startApp({ apiBase: be.base, keyPrefix: 'ak_', oauthSecret: SECRET, publicUrl: PUBLIC })
})
afterAll(async () => { await app.close(); await be.close(); vi.restoreAllMocks(); vi.useRealTimers() })
afterEach(() => { be.requests.length = 0; vi.setSystemTime(Date.now() + 61_000) })

const authParams = (o: Record<string, string> = {}) => ({
  response_type: 'code', client_id: 'c1', redirect_uri: REDIRECT, state: 'st-1',
  code_challenge: pkce(VERIFIER), code_challenge_method: 'S256', ...o,
})
const form = (url: string, body: Record<string, string>) =>
  fetch(app.url + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })

async function getCode(o: Record<string, string> = {}) {
  const r = await form('/mcp-oauth/authorize', { ...authParams(o), api_key: KEY })
  expect(r.status).toBe(302)
  return new URL(r.headers.get('location')!)
}
const token = (body: Record<string, string>) => form('/mcp-oauth/token', body)
const initWith = (bearer: string) => mcpPost(app.url + '/mcp', initBody(), { authorization: `Bearer ${bearer}` })

describe('oauth: discovery', () => {
  it('When fetching AS metadata, Then S256-only PKCE + public endpoints are advertised', async () => {
    const m: any = await (await fetch(app.url + '/.well-known/oauth-authorization-server')).json()
    expect(m).toMatchObject({ issuer: PUBLIC, token_endpoint: `${PUBLIC}/mcp-oauth/token`, code_challenge_methods_supported: ['S256'] })
  })
  it('When fetching protected-resource metadata, Then the resource is <public>/mcp', async () => {
    const m: any = await (await fetch(app.url + '/.well-known/oauth-protected-resource/mcp')).json()
    expect(m).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] })
  })
  it('Given no credentials, When initializing, Then 401 with a WWW-Authenticate resource_metadata challenge', async () => {
    const r = await mcpPost(app.url + '/mcp', initBody())
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`)
  })
  it('When registering a client, Then a public client id is issued', async () => {
    const r = await fetch(app.url + '/mcp-oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })
    expect(r.status).toBe(201)
    expect(await r.json()).toMatchObject({ client_id: expect.stringMatching(/^mcpc_/), token_endpoint_auth_method: 'none' })
  })
})

describe('oauth: authorize validation', () => {
  it.each([
    ['wrong response_type', { response_type: 'token' }],
    ['missing redirect_uri', { redirect_uri: '' }],
    ['non-allowlisted redirect', { redirect_uri: 'https://evil.com/cb' }],
    ['look-alike redirect', { redirect_uri: 'https://evilclaude.ai/cb' }],
    ['http redirect to public host', { redirect_uri: 'http://claude.ai/cb' }],
    ['missing code_challenge', { code_challenge: '' }],
    ['plain PKCE', { code_challenge_method: 'plain' }],
    ['no PKCE method (defaults to plain)', { code_challenge_method: '' }],
  ])('Given %s, When GET/POST authorize, Then 400', async (_n, o) => {
    const p = authParams(o)
    for (const k of Object.keys(p) as (keyof typeof p)[]) if (!p[k]) delete p[k]
    expect((await fetch(app.url + '/mcp-oauth/authorize?' + new URLSearchParams(p))).status).toBe(400)
    expect((await form('/mcp-oauth/authorize', { ...p, api_key: KEY })).status).toBe(400)
    expect(be.requests).toHaveLength(0)
  })
  it('Given valid params with an XSS state, When GET authorize, Then the form is rendered with escaped values', async () => {
    const r = await fetch(app.url + '/mcp-oauth/authorize?' + new URLSearchParams(authParams({ state: '"><script>x</script>' })))
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(html).toContain('name="api_key"')
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })
  it.each(['http://localhost:3000/cb', 'https://chatgpt.com/connector/cb', 'https://x.anthropic.com/cb'])(
    'Given allowlisted redirect %s, When GET authorize, Then 200', async (redirect_uri) => {
      expect((await fetch(app.url + '/mcp-oauth/authorize?' + new URLSearchParams(authParams({ redirect_uri })))).status).toBe(200)
    })
  it('Given a key with the wrong prefix, When POST authorize, Then the form re-renders with an error and the backend is not called', async () => {
    const r = await form('/mcp-oauth/authorize', { ...authParams(), api_key: 'zz_bad' })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('must start with')
    expect(be.requests).toHaveLength(0)
  })
  it('Given a key the backend rejects, When POST authorize, Then the form shows an error without echoing the key', async () => {
    const r = await form('/mcp-oauth/authorize', { ...authParams(), api_key: 'ak_revoked_123' })
    const html = await r.text()
    expect(html).toContain('invalid')
    expect(html).not.toContain('ak_revoked_123')
  })
  it('Given a valid key, When POST authorize, Then 302 to redirect_uri with code + state (key not visible)', async () => {
    const loc = await getCode()
    expect(loc.origin + loc.pathname).toBe(REDIRECT)
    expect(loc.searchParams.get('state')).toBe('st-1')
    expect(loc.searchParams.get('code')).toBeTruthy()
    expect(loc.toString()).not.toContain(KEY)
  })
})

describe('oauth: token endpoint + PKCE', () => {
  it('Given a valid code + verifier, When exchanging, Then tokens are issued and the access token opens an MCP session', async () => {
    const code = (await getCode()).searchParams.get('code')!
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER })
    const t: any = await r.json()
    expect(r.status).toBe(200)
    expect(t).toMatchObject({ token_type: 'Bearer', scope: 'mcp', expires_in: 30 * 24 * 3600 })
    expect(JSON.stringify(t)).not.toContain(KEY)
    const s = await initWith(t.access_token)
    expect(s.status).toBe(200)
    expect(be.requests.at(-1)).toMatchObject({ url: '/api/ext/me', auth: `Bearer ${KEY}` })
  })
  it('Given a code already exchanged, When replayed, Then invalid_grant "already used"', async () => {
    const code = (await getCode()).searchParams.get('code')!
    const body = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER }
    expect((await token(body)).status).toBe(200)
    const r = await token(body)
    expect(r.status).toBe(400)
    expect((await r.json() as any).error_description).toContain('already used')
  })
  it.each([
    ['wrong verifier', { code_verifier: 'other-verifier'.padEnd(64, 'y') }, 'PKCE'],
    ['missing verifier', { code_verifier: '' }, 'PKCE'],
    ['redirect_uri mismatch', { redirect_uri: 'https://claude.ai/other' }, 'redirect_uri'],
    ['garbage code', { code: 'garbage' }, 'invalid'],
  ])('Given %s, When exchanging, Then 400 invalid_grant', async (_n, o, msg) => {
    const code = (await getCode()).searchParams.get('code')!
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...o })
    const j: any = await r.json()
    expect(r.status).toBe(400)
    expect(j.error).toBe('invalid_grant')
    expect(j.error_description).toContain(msg)
  })
  it('Given an expired code, When exchanging, Then invalid_grant', async () => {
    const code = forgeToken(SECRET, { k: KEY, cc: pkce(VERIFIER), ru: REDIRECT, exp: Date.now() - 1, n: 'n1', t: 'code' })
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER })).status).toBe(400)
  })
  it('Given an access token used as a code, When exchanging, Then invalid_grant', async () => {
    const code = forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' })
    expect((await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER })).status).toBe(400)
  })
  it('Given a refresh token, When refreshing, Then a new working access token is issued; an access token is not accepted as refresh', async () => {
    const code = (await getCode()).searchParams.get('code')!
    const t: any = await (await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER })).json()
    const r: any = await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json()
    expect((await initWith(r.access_token)).status).toBe(200)
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.access_token })).status).toBe(400)
    const expired = forgeToken(SECRET, { k: KEY, exp: Date.now() - 1, t: 'refresh' })
    expect((await token({ grant_type: 'refresh_token', refresh_token: expired })).status).toBe(400)
  })
  it('Given an unknown grant_type, Then 400 unsupported_grant_type', async () => {
    const r = await token({ grant_type: 'password' })
    expect(await r.json()).toEqual({ error: 'unsupported_grant_type' })
  })
})

describe('oauth: access token verification at /mcp', () => {
  it('Given a valid forged-with-same-secret token, Then accepted (stateless, survives restart)', async () => {
    expect((await initWith(forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' }))).status).toBe(200)
  })
  it.each([
    ['expired', () => forgeToken(SECRET, { k: KEY, exp: Date.now() - 1, t: 'access' })],
    ['wrong secret (signature)', () => forgeToken('another-secret-0123456789', { k: KEY, exp: Date.now() + DAY, t: 'access' })],
    ['refresh token used as access', () => forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'refresh' })],
    ['wrapped key without prefix', () => forgeToken(SECRET, { k: 'zz_other', exp: Date.now() + DAY, t: 'access' })],
    ['non-string key', () => forgeToken(SECRET, { k: 42, exp: Date.now() + DAY, t: 'access' })],
    ['tampered ciphertext', () => {
      const b = Buffer.from(forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' }), 'base64url')
      b[b.length - 1] ^= 1
      return b.toString('base64url')
    }],
    ['too short', () => 'abc'],
  ])('Given a %s token, When initializing, Then 401 and the backend is not called', async (_n, mk) => {
    const r = await initWith(mk())
    expect(r.status).toBe(401)
    expect(be.requests).toHaveLength(0)
  })
  it('Given a raw API key, When initializing with OAuth on, Then header-key auth still works', async () => {
    expect((await initWith(KEY)).status).toBe(200)
  })
})

describe('oauth: existing session re-auth', () => {
  const CHALLENGE = `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`
  async function oauthSession() {
    const tok = forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' })
    const r = await initWith(tok)
    expect(r.status).toBe(200)
    return { tok, sid: r.headers.get('mcp-session-id')! }
  }
  const list = (sid: string, h: Record<string, string>) =>
    mcpPost(app.url + '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid, ...h })

  it('Given the same valid token or the raw wrapped key, When reusing the session, Then it is served', async () => {
    const { tok, sid } = await oauthSession()
    expect((await list(sid, { authorization: `Bearer ${tok}` })).status).toBe(200)
    expect((await list(sid, { authorization: `Bearer ${KEY}` })).status).toBe(200)
  })
  it.each([
    ['an expired token', () => ({ authorization: `Bearer ${forgeToken(SECRET, { k: KEY, exp: Date.now() - 1, t: 'access' })}` })],
    ['a token from another secret', () => ({ authorization: `Bearer ${forgeToken('another-secret-0123456789', { k: KEY, exp: Date.now() + DAY, t: 'access' })}` })],
    ['no credentials', () => ({})],
  ])('Given %s, When reusing the session (POST/GET/DELETE), Then 401 with the OAuth challenge', async (_n, mk) => {
    const { sid } = await oauthSession()
    const h = mk() as Record<string, string>
    const r = await list(sid, h)
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toBe(CHALLENGE)
    for (const method of ['GET', 'DELETE']) {
      const x = await fetch(app.url + '/mcp', { method, headers: { 'mcp-session-id': sid, ...h } })
      expect(x.status).toBe(401)
      expect(x.headers.get('www-authenticate')).toBe(CHALLENGE)
    }
  })
  it('Given the session token has expired, When the client re-auths with a fresh token, Then the session continues', async () => {
    const { sid } = await oauthSession()
    vi.setSystemTime(Date.now() + 31 * DAY)
    expect((await list(sid, { authorization: `Bearer ${forgeToken(SECRET, { k: KEY, exp: Date.now() - 1, t: 'access' })}` })).status).toBe(401)
    const fresh = forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' })
    expect((await list(sid, { authorization: `Bearer ${fresh}` })).status).toBe(200)
  })
})

describe('oauth: without a key prefix', () => {
  it('Given MCP_KEY_PREFIX unset, When initializing with an OAuth access token, Then the wrapped key is used (not the token)', async () => {
    const app2 = await startApp({ apiBase: be.base, keyPrefix: '', oauthSecret: SECRET, publicUrl: PUBLIC })
    try {
      const tok = forgeToken(SECRET, { k: KEY, exp: Date.now() + DAY, t: 'access' })
      const r = await mcpPost(app2.url + '/mcp', initBody(), { authorization: `Bearer ${tok}` })
      expect(r.status).toBe(200)
      expect(be.requests.at(-1)!.auth).toBe(`Bearer ${KEY}`)
      expect((await mcpPost(app2.url + '/mcp', initBody(), { authorization: `Bearer ${KEY}` })).status).toBe(200)
    } finally { await app2.close() }
  })
})

describe('oauth: rate limit', () => {
  it('Given 20 token requests in a minute from one IP, Then the 21st gets 429', async () => {
    const app3 = await startApp({ apiBase: be.base, keyPrefix: 'ak_', oauthSecret: SECRET, publicUrl: PUBLIC })
    try {
      const post = () => fetch(app3.url + '/mcp-oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=x' })
      for (let i = 0; i < 20; i++) expect((await post()).status).toBe(400)
      const r = await post()
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBe('60')
    } finally { await app3.close() }
  })
})
