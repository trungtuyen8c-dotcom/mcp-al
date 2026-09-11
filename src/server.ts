// server.ts — build the McpServer + register tools. Each tool = one backend endpoint + one scope.
// EDIT THE TOOL LIST HERE for your project.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, type ZodRawShape } from 'zod'
import { ApiClient, ApiError } from './apiClient.js'
import { auditToolCall } from './audit.js'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

export function buildServer(client: ApiClient): McpServer {
  const server = new McpServer({ name: 'mcp-al-mcp', version: '0.1.0' })

  // Helper: register one read-tool. run() calls the backend; the wrapper handles audit + error mapping.
  function readTool(name: string, description: string, schema: ZodRawShape, run: (a: any) => Promise<unknown>) {
    server.tool(name, description, schema, async (args: any): Promise<Result> => {
      const t = Date.now()
      try {
        const data = await run(args)
        auditToolCall({ tool: name, params: args ?? {}, result: 'success', durationMs: Date.now() - t })
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      } catch (e) {
        const msg = e instanceof ApiError ? `[${e.code}] ${e.message}` : (e as Error).message || 'error'
        auditToolCall({ tool: name, params: args ?? {}, result: 'error', durationMs: Date.now() - t, error: msg })
        return { content: [{ type: 'text', text: `Tool "${name}" error: ${msg}` }], isError: true }
      }
    })
  }

  // ── whoami — no scope required. Checks the key is valid + shows its scopes. ──
  readTool('whoami', 'Check the API key is valid and return the key name + its scopes.', {},
    () => client.get('/ext/me'))

  readTool('list_orders', 'List orders, filter by status/source/date range. scope: orders:read.',
    {
      limit: z.number().int().min(1).max(50).optional(),
      status: z.string().max(30).optional(),
      source: z.string().max(30).optional(),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    (a) => client.get('/ext/orders', { limit: a.limit, status: a.status, source: a.source, dateFrom: a.dateFrom, dateTo: a.dateTo }))

  readTool('get_order', 'Get one order by code. scope: orders:read.',
    { code: z.string().min(1).max(30) },
    (a) => client.get(`/ext/orders/${encodeURIComponent(a.code)}`))

  readTool('list_customers', 'List customers, filter by name/code. scope: customers:read.',
    { limit: z.number().int().min(1).max(50).optional(), q: z.string().max(100).optional() },
    (a) => client.get('/ext/customers', { limit: a.limit, q: a.q }))

  readTool('list_trackings', 'List trackings, filter by customer name / in-stock only. scope: trackings:read.',
    { limit: z.number().int().min(1).max(50).optional(), customer: z.string().max(100).optional(), stock: z.boolean().optional() },
    (a) => client.get('/ext/trackings', { limit: a.limit, customer: a.customer, stock: a.stock === undefined ? undefined : String(a.stock) }))

  readTool('read_report', 'Read one read-only report by name. Each report needs its own scope (key may lack it): ' +
    'stats_overview, stats_alerts [scope reports:stats]; ' +
    'control_overview, control_debt_config, control_overdue_debts, control_cartons, control_unmatched [scope reports:control]; ' +
    'warehouse_vn_board, warehouse_stored, warehouse_history, warehouse_recon [scope reports:warehouse]; ' +
    'users_list, roles_list, permissions_list, audit_log [scope reports:admin]; ' +
    'companycost_report (param: month=YYYY-MM), companycost_settlement (param: month), companycost_reinforce_price, companycost_electronics_price [scope reports:companycost]; ' +
    'shipments_tax_audit (param: month), shipments_invoice_checklist (param: month), shipments_tax_rows, shipments_documents (param: orderId?) [scope reports:shipments]; ' +
    'accounting_debts, accounting_deposits, accounting_deposits_counts, accounting_opening_balances, accounting_customer_summary, ' +
    'accounting_monthly_report (param: month), accounting_wallets, accounting_fund, accounting_fund_counts, accounting_reconcile, accounting_statement (param: walletId) [scope reports:accounting].',
    {
      report: z.string().min(1).max(50),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('YYYY-MM, dùng cho report theo tháng'),
      walletId: z.string().uuid().optional().describe('bắt buộc cho accounting_statement'),
      orderId: z.string().uuid().optional().describe('lọc cho shipments_documents'),
      status: z.string().optional().describe('pending/confirmed/fix_request, dùng cho accounting_deposits/accounting_fund'),
      limit: z.number().int().min(1).max(300).optional().describe('dùng cho audit_log'),
    },
    (a) => client.get('/ext/reports', { report: a.report, month: a.month, walletId: a.walletId, orderId: a.orderId, status: a.status, limit: a.limit }))

  return server
}
