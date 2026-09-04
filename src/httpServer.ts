#!/usr/bin/env node
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./createServer.js";

// Mỗi request tra API key riêng từ header - key ai người đó tạo (mỗi nhân viên 1 key, đúng scope
// quyền của người đó). Server này KHÔNG dùng chung 1 key server-side như bin stdio (src/index.ts).
function extractApiKey(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
  return null;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// Stateless: mỗi request tạo 1 McpServer + transport riêng, gắn đúng apiKey của request đó, rồi đóng
// lại ngay sau khi trả response. Không giữ session giữa các request vì mọi tool đều chỉ đọc và tự
// đủ ngữ cảnh trong 1 lần gọi (không cần state chia sẻ giữa các request của cùng 1 client).
async function handleMcp(req: Request, res: Response) {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Thiếu API key - gửi header Authorization: Bearer <oak_...>" },
      id: null,
    });
    return;
  }

  const server = createMcpServer({ apiKey, baseUrl: process.env.MCP_AL_BASE_URL });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`mcp-al remote (Streamable HTTP) listening on :${port} - endpoint POST/GET /mcp`);
});
