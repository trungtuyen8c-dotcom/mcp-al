import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'

const ORIGINAL = { ...process.env }
let errors: string[]

function load(env: Record<string, string>) {
  for (const k of Object.keys(process.env)) if (k.startsWith('MCP_') || k === 'PORT') delete process.env[k]
  Object.assign(process.env, env)
  return loadConfig()
}

beforeEach(() => {
  errors = []
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`) }) as never)
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
})
afterEach(() => { vi.restoreAllMocks(); process.env = { ...ORIGINAL } })

describe('config: MCP_API_BASE', () => {
  it('Given no MCP_API_BASE, When loading, Then it exits 1', () => {
    expect(() => load({})).toThrow('exit:1')
    expect(errors.join()).toContain('MCP_API_BASE')
  })
  it('Given a blank MCP_API_BASE, When loading, Then it exits 1', () => {
    expect(() => load({ MCP_API_BASE: '   ' })).toThrow('exit:1')
  })
  it('Given an invalid URL, When loading, Then it exits 1', () => {
    expect(() => load({ MCP_API_BASE: 'not a url' })).toThrow('exit:1')
  })
  it('Given a public http URL, When loading, Then it exits 1 (key would leak in clear)', () => {
    expect(() => load({ MCP_API_BASE: 'http://api.example.com/api' })).toThrow('exit:1')
    expect(errors.join()).toContain('HTTPS')
  })
  it.each([
    'https://api.example.com/api',
    'http://localhost:8080/api',
    'http://127.0.0.1:8080/api',
    'http://backend:8080/api',
  ])('Given %s, When loading, Then it is accepted', (base) => {
    expect(load({ MCP_API_BASE: base }).apiBase).toBe(base)
  })
  it('Given trailing slashes, When loading, Then they are stripped', () => {
    expect(load({ MCP_API_BASE: 'https://api.example.com/api///' }).apiBase).toBe('https://api.example.com/api')
  })
})

describe('config: defaults and numbers', () => {
  it('Given only MCP_API_BASE, When loading, Then defaults apply', () => {
    const c = load({ MCP_API_BASE: 'https://a.example.com' })
    expect(c).toMatchObject({ transport: 'http', port: 8787, timeoutMs: 10_000, keyPrefix: '' })
    expect(c.oauthSecret).toBeUndefined()
    expect(c.envApiKey).toBeUndefined()
  })
  it('Given PORT/MCP_HTTP_TIMEOUT_MS/MCP_KEY_PREFIX, When loading, Then they are used', () => {
    const c = load({ MCP_API_BASE: 'https://a.example.com', PORT: '9000', MCP_HTTP_TIMEOUT_MS: '2500', MCP_KEY_PREFIX: ' ak_ ' })
    expect(c).toMatchObject({ port: 9000, timeoutMs: 2500, keyPrefix: 'ak_' })
  })
  it.each(['abc', '0', '-5', '1.5', '10s'])('Given MCP_HTTP_TIMEOUT_MS=%s, When loading, Then it exits 1', (v) => {
    expect(() => load({ MCP_API_BASE: 'https://a.example.com', MCP_HTTP_TIMEOUT_MS: v })).toThrow('exit:1')
    expect(errors.join()).toContain('MCP_HTTP_TIMEOUT_MS')
  })
  it('Given a blank MCP_HTTP_TIMEOUT_MS, When loading, Then the 10000 default applies', () => {
    expect(load({ MCP_API_BASE: 'https://a.example.com', MCP_HTTP_TIMEOUT_MS: ' ' }).timeoutMs).toBe(10_000)
  })
  it('Given an unknown MCP_TRANSPORT, When loading, Then it falls back to http', () => {
    expect(load({ MCP_API_BASE: 'https://a.example.com', MCP_TRANSPORT: 'grpc' }).transport).toBe('http')
  })
})

describe('config: stdio', () => {
  it('Given stdio without MCP_API_KEY, When loading, Then it exits 1', () => {
    expect(() => load({ MCP_API_BASE: 'https://a.example.com', MCP_TRANSPORT: 'STDIO' })).toThrow('exit:1')
    expect(errors.join()).toContain('MCP_API_KEY')
  })
  it('Given stdio with a key lacking the prefix, When loading, Then it exits without printing the key', () => {
    expect(() => load({ MCP_API_BASE: 'https://a.example.com', MCP_TRANSPORT: 'stdio', MCP_KEY_PREFIX: 'ak_', MCP_API_KEY: 'zz_supersecret' })).toThrow('exit:1')
    expect(errors.join()).not.toContain('supersecret')
  })
  it('Given stdio with a valid key, When loading, Then envApiKey is set and OAuth is ignored', () => {
    const c = load({ MCP_API_BASE: 'https://a.example.com', MCP_TRANSPORT: 'stdio', MCP_KEY_PREFIX: 'ak_', MCP_API_KEY: 'ak_123', MCP_OAUTH_SECRET: 'short' })
    expect(c.envApiKey).toBe('ak_123')
    expect(c.oauthSecret).toBeUndefined()
  })
})

describe('config: OAuth (http)', () => {
  const base = { MCP_API_BASE: 'https://a.example.com' }
  it('Given MCP_OAUTH_SECRET < 16 chars, When loading, Then it fails fast (does not silently disable OAuth) and hides the secret', () => {
    expect(() => load({ ...base, MCP_OAUTH_SECRET: 'tooShortSecret1', MCP_PUBLIC_URL: 'https://mcp.example.com' })).toThrow('exit:1')
    expect(errors.join()).toContain('too short')
    expect(errors.join()).not.toContain('tooShortSecret1')
  })
  it('Given a secret but no MCP_PUBLIC_URL, When loading, Then it exits 1', () => {
    expect(() => load({ ...base, MCP_OAUTH_SECRET: 'x'.repeat(16) })).toThrow('exit:1')
  })
  it('Given an http public URL, When loading, Then it exits 1', () => {
    expect(() => load({ ...base, MCP_OAUTH_SECRET: 'x'.repeat(16), MCP_PUBLIC_URL: 'http://mcp.example.com' })).toThrow('exit:1')
  })
  it('Given an invalid public URL, When loading, Then it exits 1', () => {
    expect(() => load({ ...base, MCP_OAUTH_SECRET: 'x'.repeat(16), MCP_PUBLIC_URL: 'nope' })).toThrow('exit:1')
  })
  it('Given a 16-char secret + https public URL, When loading, Then OAuth is enabled', () => {
    const c = load({ ...base, MCP_OAUTH_SECRET: 'x'.repeat(16), MCP_PUBLIC_URL: 'https://mcp.example.com/' })
    expect(c.oauthSecret).toBe('x'.repeat(16))
    expect(c.publicUrl).toBe('https://mcp.example.com')
  })
  it('Given no secret, When loading, Then OAuth stays disabled even with a public URL', () => {
    const c = load({ ...base, MCP_PUBLIC_URL: 'https://mcp.example.com' })
    expect(c.oauthSecret).toBeUndefined()
    expect(c.publicUrl).toBeUndefined()
  })
})
