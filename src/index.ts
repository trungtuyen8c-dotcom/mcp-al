import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiGet, ApiError } from "./apiClient.js";

const server = new McpServer({ name: "mcp-al", version: "0.1.0" });

const MAX_ITEMS = 50;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err: unknown) {
  const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Lỗi: ${message}` }], isError: true };
}

// Cắt bớt mảng lớn (top-level hoặc field trong object) để không tràn context của agent.
function truncate(data: unknown): unknown {
  if (Array.isArray(data)) {
    if (data.length <= MAX_ITEMS) return data;
    return { truncated: `${MAX_ITEMS}/${data.length} dòng`, items: data.slice(0, MAX_ITEMS) };
  }
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > MAX_ITEMS) {
        out[k] = v.slice(0, MAX_ITEMS);
        out[`${k}_truncated`] = `${MAX_ITEMS}/${v.length}`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return data;
}

// Danh sách báo cáo/danh sách chỉ đọc mà server này CÓ THỂ gọi - khớp với các route backend đã gắn
// scope API key riêng (xem orderhangnhat-backend/src/utils/apiKey.ts). Key API key không cấp scope
// tương ứng thì backend tự chặn 403, tool này không mở thêm quyền nào ngoài đó.
const REPORTS: Record<string, string> = {
  stats_overview: "/stats",
  stats_alerts: "/stats/alerts",
  shipments_tax_audit: "/shipments/tax-audit",
  shipments_invoice_checklist: "/shipments/invoice-checklist",
  shipments_tax_rows: "/shipments/tax-rows",
  shipments_documents: "/shipments/documents",
  users_list: "/admin/users",
  roles_list: "/admin/roles",
  permissions_list: "/admin/permissions",
  audit_log: "/admin/audit",
  companycost_report: "/companycost/report",
  companycost_settlement: "/companycost/settlement",
  companycost_reinforce_price: "/companycost/reinforce-price",
  companycost_electronics_price: "/companycost/electronics-price",
  accounting_debts: "/accounting/debts",
  accounting_deposits: "/accounting/deposits",
  accounting_deposits_counts: "/accounting/deposits/counts",
  accounting_opening_balances: "/accounting/opening-balances",
  accounting_customer_summary: "/accounting/customer-summary",
  accounting_monthly_report: "/accounting/monthly-report",
  accounting_wallets: "/accounting/wallets",
  accounting_fund: "/accounting/fund",
  accounting_fund_counts: "/accounting/fund/counts",
  accounting_reconcile: "/accounting/reconcile",
  accounting_statement: "/accounting/statement",
  control_overview: "/control/overview",
  control_debt_config: "/control/debt-config",
  control_overdue_debts: "/control/overdue-debts",
  control_cartons: "/control/cartons",
  control_unmatched: "/control/unmatched",
  warehouse_vn_board: "/warehouse/vn-board",
  warehouse_stored: "/warehouse/stored",
  warehouse_history: "/warehouse/history",
  warehouse_recon: "/warehouse/recon",
};
const REPORT_KEYS = Object.keys(REPORTS) as [string, ...string[]];

interface OrderRow {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  customer?: { name: string };
  totalVnd?: string | null;
  deposit?: string;
  trackings?: { code: string; vnTrackingCode: string | null; deliveredAt: string | null }[];
}

server.tool(
  "list_orders",
  "Liệt kê đơn hàng (chỉ đọc). Lọc theo trạng thái/nguồn nếu cần.",
  {
    status: z.string().optional().describe("Lọc theo trạng thái đơn, vd: draft, quoted, delivered..."),
    source: z.string().optional().describe("Lọc theo nguồn: yahoo, mercari, normal..."),
    limit: z.number().int().positive().max(MAX_ITEMS).default(20).describe("Số đơn tối đa trả về"),
  },
  async ({ status, source, limit }) => {
    try {
      const rows = await apiGet<OrderRow[]>("/orders", { source });
      const filtered = status ? rows.filter((o) => o.status === status) : rows;
      const sliced = filtered.slice(0, limit);
      return text({
        total_matched: filtered.length,
        returned: sliced.length,
        orders: sliced.map((o) => ({
          code: o.code,
          status: o.status,
          customer: o.customer?.name ?? null,
          orderDate: o.orderDate,
          totalVnd: o.totalVnd,
          deposit: o.deposit,
          trackingCount: o.trackings?.length ?? 0,
        })),
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "get_order",
  "Tra chi tiết 1 đơn hàng theo mã đơn (chỉ đọc).",
  { code: z.string().min(1).describe("Mã đơn hàng, vd: DH-0001") },
  async ({ code }) => {
    try {
      const lookup = await apiGet<{ order: { id: string; code: string; customerName: string } | null }>(
        "/orders/lookup-code",
        { code }
      );
      if (!lookup.order) return text({ found: false, message: `Không tìm thấy đơn mã ${code}` });

      const detail = await apiGet<Record<string, unknown>>(`/orders/${lookup.order.id}`);
      return text(detail);
    } catch (err) {
      return errorText(err);
    }
  }
);

interface CustomerRow {
  id: string;
  code: string | null;
  name: string;
  phone?: string | null;
  debtVnd?: number;
  revenueVnd?: number;
}

server.tool(
  "list_customers",
  "Liệt kê khách hàng (chỉ đọc). Có thể lọc theo tên/mã khách.",
  {
    search: z.string().optional().describe("Tìm theo tên hoặc mã khách (không phân biệt hoa thường)"),
    limit: z.number().int().positive().max(MAX_ITEMS).default(20),
  },
  async ({ search, limit }) => {
    try {
      const rows = await apiGet<CustomerRow[]>("/customers");
      const q = search?.trim().toLowerCase();
      const filtered = q ? rows.filter((c) => c.name.toLowerCase().includes(q) || c.code?.toLowerCase().includes(q)) : rows;
      const sliced = filtered.slice(0, limit);
      return text({ total_matched: filtered.length, returned: sliced.length, customers: sliced });
    } catch (err) {
      return errorText(err);
    }
  }
);

interface TrackingRow {
  code: string;
  vnTrackingCode: string | null;
  deliveredAt: string | null;
  packedAt: string | null;
  order?: { code: string; customer?: { name: string } };
}

server.tool(
  "list_trackings",
  "Liệt kê mã tracking (chỉ đọc). Lọc theo tên khách hoặc chỉ hàng tồn kho chưa gửi VN.",
  {
    customer: z.string().optional().describe("Lọc theo tên khách hàng (chứa chuỗi này)"),
    stockOnly: z.boolean().optional().describe("true = chỉ lấy hàng đã về kho Nhật nhưng chưa có mã tracking VN"),
    limit: z.number().int().positive().max(MAX_ITEMS).default(20),
  },
  async ({ customer, stockOnly, limit }) => {
    try {
      const rows = await apiGet<TrackingRow[]>("/trackings", {
        customer,
        stock: stockOnly ? "1" : undefined,
      });
      const sliced = rows.slice(0, limit);
      return text({
        total_matched: rows.length,
        returned: sliced.length,
        trackings: sliced.map((t) => ({
          code: t.code,
          orderCode: t.order?.code ?? null,
          customer: t.order?.customer?.name ?? null,
          vnTrackingCode: t.vnTrackingCode,
          packedAt: t.packedAt,
          deliveredAt: t.deliveredAt,
        })),
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "read_report",
  "Đọc 1 báo cáo/danh sách chỉ đọc khác trong hệ thống (thống kê, công nợ, ví/quỹ, kho VN, chứng từ hải quan, " +
    "audit log, danh sách user/role...). Chỉ hoạt động nếu API key được cấp đúng scope cho báo cáo đó.",
  {
    report: z.enum(REPORT_KEYS).describe("Tên báo cáo, xem enum để biết danh sách hợp lệ"),
    params: z.record(z.string()).optional().describe("Query params tùy chọn, vd { month: '2026-08' }"),
  },
  async ({ report, params }) => {
    try {
      const data = await apiGet<unknown>(REPORTS[report], params);
      return text(truncate(data));
    } catch (err) {
      return errorText(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
