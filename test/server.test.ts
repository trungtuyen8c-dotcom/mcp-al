import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server.js'
import { ApiClient } from '../src/apiClient.js'
import { startBackend, type Backend } from './helpers.js'

const KEY = 'ak_tool_key_456'
const UUID = '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b'
let be: Backend
let mcp: Client
let stderr: string[]

beforeAll(async () => {
  be = await startBackend()
  const [a, b] = InMemoryTransport.createLinkedPair()
  await buildServer(new ApiClient({ apiBase: be.base, apiKey: KEY, timeoutMs: 2000 })).connect(a)
  mcp = new Client({ name: 't', version: '1' })
  await mcp.connect(b)
})
afterAll(async () => { await mcp.close(); await be.close() })
afterEach(() => { be.requests.length = 0; be.setHandler(() => ({ body: { data: { ok: true } } })); vi.restoreAllMocks() })

const text = (r: any) => r.content.map((c: any) => c.text).join('\n') as string
const call = (name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args })

// Validation failures may surface as a thrown McpError or an isError result depending on SDK version.
async function expectInvalid(name: string, args: Record<string, unknown>) {
  let r: any
  try { r = await call(name, args) } catch (e) { expect(String(e)).toMatch(/invalid/i); expect(be.requests).toHaveLength(0); return }
  expect(r.isError).toBe(true)
  expect(text(r)).toMatch(/invalid/i)
  expect(be.requests).toHaveLength(0)
}

describe('tools: listing', () => {
  it('When listing tools, Then exactly the 6 read tools are exposed', async () => {
    const { tools } = await mcp.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['get_order', 'list_customers', 'list_orders', 'list_trackings', 'read_report', 'whoami'])
  })
})

describe('tools: forwarding', () => {
  it.each([
    ['whoami', {}, '/api/ext/me'],
    ['list_orders', { limit: 10, status: 'new', source: 'web', dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      '/api/ext/orders?limit=10&status=new&source=web&dateFrom=2026-01-01&dateTo=2026-01-31'],
    ['list_orders', {}, '/api/ext/orders'],
    ['get_order', { code: 'OD 1/2' }, '/api/ext/orders/OD%201%2F2'],
    ['list_customers', { limit: 3, q: 'tuyen' }, '/api/ext/customers?limit=3&q=tuyen'],
    ['list_trackings', { customer: 'A', stock: false }, '/api/ext/trackings?customer=A&stock=false'],
    ['list_trackings', { stock: true }, '/api/ext/trackings?stock=true'],
    ['read_report', { report: 'accounting_statement', walletId: UUID }, `/api/ext/reports?report=accounting_statement&walletId=${UUID}`],
    ['read_report', { report: 'companycost_report', month: '2026-09' }, '/api/ext/reports?report=companycost_report&month=2026-09'],
    ['read_report', { report: 'shipments_documents', orderId: UUID, status: 'pending', limit: 300 },
      `/api/ext/reports?report=shipments_documents&orderId=${UUID}&status=pending&limit=300`],
  ])('Given %s %j, When called, Then backend gets %s with the key', async (name, args, url) => {
    const r: any = await call(name, args)
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(text(r))).toEqual({ ok: true })
    expect(be.requests).toHaveLength(1)
    expect(be.requests[0]).toMatchObject({ method: 'GET', url, auth: `Bearer ${KEY}` })
  })
  it.each(['2026-01', '2026-10', '2026-12'])('Given month %s, When read_report, Then it is accepted', async (month) => {
    const r: any = await call('read_report', { report: 'companycost_report', month })
    expect(r.isError).toBeFalsy()
    expect(be.requests[0].url).toContain(`month=${month}`)
  })
  it('Given code "..", When get_order, Then it is rejected (would otherwise resolve to /api/ext/)', async () => {
    await expectInvalid('get_order', { code: '..' })
    await expectInvalid('get_order', { code: '.' })
  })
})

describe('tools: permission errors', () => {
  it.each([
    [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [500, 'HTTP_500'],
  ])('Given backend %i, When a tool is called, Then an MCP isError result with [%s] and no key', async (status, code) => {
    be.setHandler(() => ({ status, body: { error: 'x' } }))
    const r: any = await call('list_orders', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(`[${code}]`)
    expect(text(r)).not.toContain(KEY)
  })
  it('Given a key with only reports:stats, When read_report per domain, Then only stats reports succeed', async () => {
    be.setHandler((r) => {
      const report = new URL(r.url, 'http://x').searchParams.get('report') || ''
      return report.startsWith('stats_') ? { body: { data: { report } } } : { status: 403, body: {} }
    })
    const ok: any = await call('read_report', { report: 'stats_overview' })
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(text(ok))).toEqual({ report: 'stats_overview' })
    for (const report of ['accounting_debts', 'warehouse_stored', 'users_list', 'control_overview']) {
      const r: any = await call('read_report', { report })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('[FORBIDDEN]')
    }
  })
  it('Given an unknown report name, When read_report, Then it is forwarded and the backend error is surfaced', async () => {
    be.setHandler(() => ({ status: 400, body: { error: 'unknown report' } }))
    const r: any = await call('read_report', { report: 'no_such_report' })
    expect(be.requests[0].url).toBe('/api/ext/reports?report=no_such_report')
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('[HTTP_400]')
  })
})

describe('tools: input validation', () => {
  it.each([
    ['list_orders', { limit: 0 }], ['list_orders', { limit: 51 }], ['list_orders', { limit: 1.5 }], ['list_orders', { limit: '10' }],
    ['list_orders', { status: 'x'.repeat(31) }], ['list_orders', { source: 'x'.repeat(31) }],
    ['list_orders', { dateFrom: '2026/01/01' }], ['list_orders', { dateTo: '2026-1-1' }], ['list_orders', { dateFrom: 20260101 }],
    ['get_order', {}], ['get_order', { code: '' }], ['get_order', { code: 'x'.repeat(31) }], ['get_order', { code: 123 }],
    ['list_customers', { limit: 100 }], ['list_customers', { q: 'x'.repeat(101) }],
    ['list_trackings', { stock: 'yes' }], ['list_trackings', { customer: 'x'.repeat(101) }], ['list_trackings', { limit: -1 }],
    ['read_report', {}], ['read_report', { report: '' }], ['read_report', { report: 'x'.repeat(51) }],
    ['read_report', { report: 'r', month: '2026-9' }], ['read_report', { report: 'r', month: '2026-13' }],
    ['read_report', { report: 'r', month: '2026-00' }], ['read_report', { report: 'r', month: '2026-20' }], ['read_report', { report: 'r', month: '2026-09-01' }],
    ['read_report', { report: 'r', walletId: 'not-a-uuid' }], ['read_report', { report: 'r', orderId: '123' }],
    ['read_report', { report: 'r', limit: 301 }], ['read_report', { report: 'r', limit: 0 }],
  ])('Given %s %j, When called, Then it is rejected before reaching the backend', async (name, args) => {
    await expectInvalid(name, args)
  })
})

describe('tools: audit log', () => {
  it('When tools succeed or fail, Then a JSON audit line is written to stderr without the key', async () => {
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true }) as never)
    await call('list_customers', { q: 'abc' })
    be.setHandler(() => ({ status: 401, body: {} }))
    await call('whoami')
    const logs = lines.map(l => JSON.parse(l))
    expect(logs[0]).toMatchObject({ tool: 'list_customers', result: 'success', params: { q: 'abc' } })
    expect(logs[1]).toMatchObject({ tool: 'whoami', result: 'error' })
    expect(logs[1].error).toContain('UNAUTHORIZED')
    expect(lines.join()).not.toContain(KEY)
  })
})
