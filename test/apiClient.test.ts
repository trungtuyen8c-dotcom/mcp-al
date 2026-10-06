import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from '../src/apiClient.js'
import { startBackend, type Backend } from './helpers.js'

const KEY = 'ak_secret_key_123'
let be: Backend
beforeAll(async () => { be = await startBackend() })
afterAll(() => be.close())
afterEach(() => { be.requests.length = 0; vi.restoreAllMocks() })

const client = (o: Partial<{ apiBase: string; timeoutMs: number }> = {}) =>
  new ApiClient({ apiBase: be.base, apiKey: KEY, timeoutMs: 2000, ...o })

async function err(p: Promise<unknown>): Promise<ApiError> {
  try { await p } catch (e) { return e as ApiError }
  throw new Error('expected rejection')
}

describe('ApiClient: request', () => {
  it('Given a path, When get, Then it GETs base+path with the key as Bearer', async () => {
    be.setHandler(() => ({ body: { data: { a: 1 } } }))
    expect(await client().get('/ext/me')).toEqual({ a: 1 })
    expect(be.requests[0]).toMatchObject({ method: 'GET', url: '/api/ext/me', auth: `Bearer ${KEY}` })
  })
  it('Given a query, When get, Then empty/undefined values are dropped and numbers stringified', async () => {
    be.setHandler(() => ({ body: { data: [] } }))
    await client().get('/ext/orders', { limit: 5, status: '', source: undefined, q: 'a b' })
    expect(be.requests[0].url).toBe('/api/ext/orders?limit=5&q=a+b')
  })
  it('Given a body without data, When get, Then the whole body is returned', async () => {
    be.setHandler(() => ({ body: { items: [1] } }))
    expect(await client().get('/x')).toEqual({ items: [1] })
  })
  it('Given a non-JSON body, When get, Then null is returned', async () => {
    be.setHandler(() => ({ raw: 'not json' }))
    expect(await client().get('/x')).toBeNull()
  })
  it('Given a path that would change the host, When get, Then BAD_URL and fetch is never called', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
    const e = await err(new ApiClient({ apiBase: 'http://localhost', apiKey: KEY, timeoutMs: 100 }).get('.evil.com/x'))
    expect(e.code).toBe('BAD_URL')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('ApiClient: error mapping', () => {
  it.each([
    [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [404, 'NOT_FOUND'],
    [400, 'HTTP_400'], [500, 'HTTP_500'], [502, 'HTTP_502'],
  ])('Given backend status %i, When get, Then ApiError %s without key or backend body', async (status, code) => {
    be.setHandler(() => ({ status, body: { error: `internal detail ${KEY}` } }))
    const e = await err(client().get('/ext/me'))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe(code)
    expect(e.message).not.toContain(KEY)
    expect(e.message).not.toContain('internal detail')
  })
  it('Given a slow backend, When the timeout elapses, Then TIMEOUT', async () => {
    be.setHandler(() => ({ delayMs: 500, body: {} }))
    const e = await err(client({ timeoutMs: 50 }).get('/ext/me'))
    expect(e.code).toBe('TIMEOUT')
  })
  it('Given an unreachable backend, When get, Then NETWORK without the key', async () => {
    const e = await err(client({ apiBase: 'http://127.0.0.1:1/api' }).get('/ext/me'))
    expect(e.code).toBe('NETWORK')
    expect(e.message).not.toContain(KEY)
  })
})
