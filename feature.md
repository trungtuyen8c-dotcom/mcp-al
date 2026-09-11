# feature.md — MCP feature spec (fill this in, then generate)

This is the **intake form** for scaffolding an MCP server. Fill sections 1–3 for YOUR
project, then hand this file to Claude/an agent together with this repo and say:

> "Scaffold the MCP from `feature.md` using the MCP-STARTER-KIT templates."

The agent reads your answers, copies `templates/` into `<project>-mcp`, replaces
`__PROJECT__`, and generates one `readTool(...)` per row in your Tools table.
Section 4 is a **generic worked example** — copy its format for any kind of project.

> Prerequisite: your backend must expose an **API-key channel** (`/ext/me` + scoped
> `/ext/*` endpoints). If it doesn't yet, build it first with
> [`API-KEY-BACKEND-GUIDE.md`](API-KEY-BACKEND-GUIDE.md).

---

## 1. Project config · REQUIRED

| Field | Your value | Notes |
|---|---|---|
| **MCP project name** | `al` | repo becomes `al-mcp` |
| **Backend API base (public)** | `https://www.hanzomjp.com/api` | apiClient tự nối `/ext/...`; đi qua nginx `/api/` proxy có sẵn |
| **Backend API base (internal)** | `http://backend:4000/api` | docker service name nội bộ |
| **Key prefix** | `oak_` | giữ đúng format key hiện có (oak_...), không đổi |
| **Verify endpoint** | `/ext/me` | trả `{ name, scopes }` |
| **Enable OAuth?** (ChatGPT app / Claude web) | `yes` | dùng cho claude.ai web/desktop connector |
| **Public URL** (only if OAuth) | `https://www.hanzomjp.com` | issuer OAuth ở gốc domain (SDK ép vậy) |

---

## 2. Tools · REQUIRED

| Tool name | What it does | Scope | Backend endpoint | Params |
|---|---|---|---|---|
| `whoami` | Check key hợp lệ, trả tên + scopes | — | `GET /ext/me` | — |
| `list_orders` | Liệt kê đơn hàng, lọc trạng thái/nguồn/khoảng ngày | `orders:read` | `GET /ext/orders` | `limit:int?`, `status:string?`, `source:string?`, `dateFrom:string?`, `dateTo:string?` |
| `get_order` | Chi tiết 1 đơn theo mã | `orders:read` | `GET /ext/orders/:code` | `code:string` |
| `list_customers` | Liệt kê khách hàng, lọc tên/mã | `customers:read` | `GET /ext/customers` | `limit:int?`, `q:string?` |
| `list_trackings` | Liệt kê tracking, lọc theo khách/tồn kho | `trackings:read` | `GET /ext/trackings` | `limit:int?`, `customer:string?`, `stock:boolean?` |
| `read_report` | Đọc 1 trong các báo cáo chỉ đọc (stats, kế toán, kho, chứng từ hải quan, user/role/audit...) | `reports:read` | `GET /ext/reports` | `report:string` (enum), `params:object?` |

---

## 3. Scopes · derive from the tools above

| Scope | Label | Reads what |
|---|---|---|
| `orders:read` | Đọc đơn hàng | Danh sách/chi tiết đơn (không lộ nội bộ thanh toán) |
| `customers:read` | Đọc khách hàng | Danh sách khách |
| `trackings:read` | Đọc tracking | Danh sách tracking, tồn kho |
| `reports:read` | Đọc báo cáo | Toàn bộ report chỉ đọc (stats/kế toán/kho/hải quan/user-role/audit) |

---

## 5. Backend checklist

```
[x] api_keys table: hashed key + key_prefix + scopes[] + expires_at + revoked_at  (đã có)
[ ] + rate_limit column (int, default 120 req/phút/key)  ← CẦN THÊM
[x] Create/edit/revoke keys (super-admin UI)  (đã có, trang API Key)
[ ] RequireAPIKey(scope): verify hash → scope (403) → per-key rate limit (429) → audit  ← rate limit CẦN THÊM
[ ] Per-IP rate limit trước verify (nginx zone riêng cho /api/ext)
[ ] GET /ext/me trả { name, scopes }  ← CẦN THÊM (endpoint mới)
[ ] Mỗi /ext/* trả sanitized DTO, KHÔNG tái sử dụng route/controller thật (orders.routes.ts, customers.routes.ts...) — tách module riêng src/modules/ext/, chỉ import hàm đọc-dữ-liệu (Prisma query), không đụng route/middleware sản xuất đang chạy.
```

Ràng buộc cứng theo yêu cầu: **module `ext` không được import/sửa bất kỳ file route sản xuất nào** (`orders.routes.ts`, `warehouse.routes.ts`...). Chỉ được đọc DB qua Prisma trực tiếp hoặc gọi lại các hàm util thuần đọc (`gsheets.ts` các hàm read-only nếu cần), không gọi qua HTTP nội bộ tới chính hệ thống.
