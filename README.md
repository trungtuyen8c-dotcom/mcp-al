# mcp-al

MCP server chỉ đọc (read-only) cho hệ thống order hàng Nhật (`duan-order`). Dùng để agent AI
tra cứu đơn hàng / khách hàng / tracking qua API key, không tạo/sửa/xóa được gì.

## 1. Tạo API key

Đăng nhập backend bằng tài khoản của bạn để lấy JWT (`POST /api/auth/login`), sau đó gọi:

```
POST /api/api-keys
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "name": "mcp-al local",
  "scopes": [
    "orders.list", "orders.read", "customers.list", "trackings.list", "shipments.list",
    "stats.view", "companycost.view", "users.list", "permissions.list", "system.view_audit_log",
    "accounting.deposits.read", "accounting.wallets.read", "accounting.fund.read",
    "accounting.reconcile_list.read", "accounting.statement.read",
    "warehouse.stored.read", "warehouse.history.read", "warehouse.recon.read"
  ],
  "expiresInDays": 90
}
```

Chỉ xin đúng scope bạn cần dùng - server chỉ cấp được scope ≤ quyền thật của tài khoản bạn (vd tài khoản
Kho VN sẽ không xin được `accounting.*`). Danh sách scope đầy đủ + mô tả: xem
`orderhangnhat-backend/src/utils/apiKey.ts`.

Response trả `key` (dạng `oak_...`) đúng 1 lần — lưu lại ngay, không xem lại được sau đó.
Scope chỉ được cấp bằng hoặc thấp hơn quyền thật của tài khoản bạn (server tự chặn xin vượt quyền).

Quản lý key: `GET /api/api-keys` (liệt kê), `DELETE /api/api-keys/:id` (thu hồi).

## 2. Cấu hình (không cần cài gì)

Package đã publish public trên npm (`@trungtuyentt/mcp-al`) — chỉ cần Node.js, `npx` tự tải và chạy,
không cần clone repo/build tay. Đưa đoạn config này + key tạo ở bước 1 cho bất kỳ ai:

### Claude Desktop / Claude Code (`mcp.json`)

```json
{
  "mcpServers": {
    "mcp-al": {
      "command": "npx",
      "args": ["-y", "@trungtuyentt/mcp-al"],
      "env": {
        "MCP_AL_API_KEY": "oak_..."
      }
    }
  }
}
```

Muốn trỏ backend khác (không phải VPS production) thì thêm `"MCP_AL_BASE_URL": "http://..."` vào `env`.

### Chạy dev từ source (không bắt buộc)

```
npm install
npm run build
npm start
```

## 3. Dùng online (Remote MCP qua HTTP)

Ngoài chạy local bằng `npx` (stdio), server còn chạy được dạng remote HTTP - deploy 1 lần lên VPS,
ai cũng add thẳng bằng URL, không cần cài Node/npx trên máy.

Khác với bin stdio (1 `MCP_AL_API_KEY` cố định trong env của server), bản HTTP **không lưu key nào
ở server** - mỗi request phải tự gửi key riêng qua header:

```
Authorization: Bearer oak_...
```

(hoặc header `X-API-Key: oak_...`). Mỗi nhân viên dùng đúng key của mình, đúng scope người đó được
cấp ở bước 1 - server chỉ forward key đó sang backend, không xác thực hộ.

### Chạy server

```
npm run build
PORT=8787 MCP_AL_BASE_URL=http://103.166.184.140/api npm run start:http
```

Endpoint: `POST/GET/DELETE /mcp` (chuẩn Streamable HTTP, stateless - không lưu session). Health check:
`GET /healthz`. Production chạy trong `orderhangnhat-infra` (service `mcp-al` trong
`docker-compose.prod.yml`), đứng sau nginx tại path `/mcp-al` - xem
`orderhangnhat-infra/nginx/conf.d/app.conf`. Không expose port 8787 thẳng ra internet.

### Cấu hình client trỏ tới server online

```json
{
  "mcpServers": {
    "mcp-al": {
      "type": "http",
      "url": "https://www.hanzomjp.com/mcp-al",
      "headers": {
        "Authorization": "Bearer oak_..."
      }
    }
  }
}
```

Domain `hanzomjp.com` chạy qua Cloudflare (TLS ở edge) trỏ thẳng vào VPS này - API key đi HTTPS,
không lộ plaintext trên đường truyền.

## 4. Tools

- `list_orders` — liệt kê đơn hàng, lọc theo status/source/dateFrom/dateTo (orderDate)
- `get_order` — chi tiết 1 đơn theo mã đơn
- `list_customers` — liệt kê khách hàng, lọc theo tên/mã
- `list_trackings` — liệt kê tracking, lọc theo khách hàng / hàng tồn kho
- `read_report` — đọc các báo cáo/danh sách còn lại: thống kê (`stats_overview`, `stats_alerts`),
  chứng từ hải quan (`shipments_tax_audit`, `shipments_invoice_checklist`, `shipments_tax_rows`,
  `shipments_documents`), user/role/quyền (`users_list`, `roles_list`, `permissions_list`, `audit_log`),
  chi phí công ty (`companycost_report`, `companycost_settlement`, `companycost_reinforce_price`,
  `companycost_electronics_price`), kế toán (`accounting_debts`, `accounting_deposits`,
  `accounting_deposits_counts`, `accounting_opening_balances`, `accounting_customer_summary`,
  `accounting_monthly_report`, `accounting_wallets`, `accounting_fund`, `accounting_fund_counts`,
  `accounting_reconcile`, `accounting_statement`), tổng quan/kho (`control_overview`,
  `control_debt_config`, `control_overdue_debts`, `control_cartons`, `control_unmatched`,
  `warehouse_vn_board`, `warehouse_stored`, `warehouse_history`, `warehouse_recon`)

Tất cả đều chỉ đọc, giới hạn tối đa 50 kết quả/lần gọi để tránh tràn context. Lương nhân viên (payroll)
và các thao tác cấu hình hệ thống (backup, tax-config, pack-config...) KHÔNG expose qua API key vì
permission của các route đó dùng chung với thao tác ghi/nhạy cảm, không tách được an toàn.
