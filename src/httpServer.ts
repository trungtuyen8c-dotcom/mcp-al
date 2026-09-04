#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./createServer.js";

// Mỗi session (1 lần "Connect" của 1 client) tra API key riêng từ header lúc initialize - key ai
// người đó tạo (mỗi nhân viên 1 key, đúng scope quyền của người đó), giữ nguyên cho các request
// tools/call tiếp theo trong cùng session (nhận diện qua header Mcp-Session-Id).
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

const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"];

  if (typeof sessionId === "string" && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (typeof sessionId !== "string" && isInitializeRequest(req.body)) {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Thiếu API key - gửi header Authorization: Bearer <oak_...>" },
        id: null,
      });
      return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = createMcpServer({ apiKey, baseUrl: process.env.MCP_AL_BASE_URL });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Thiếu hoặc sai Mcp-Session-Id - phải initialize trước" },
    id: null,
  });
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`mcp-al remote (Streamable HTTP) listening on :${port} - endpoint POST/GET /mcp`);
});
