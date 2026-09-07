#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpServer } from "./createServer.js";
import { McpAlOAuthProvider, isValidApiKey, resolveIssuedToken, renderLoginForm, codes, CODE_TTL_MS } from "./oauthProvider.js";

// Auth chấp nhận 2 kiểu, song song, không đụng nhau:
// 1. Key tĩnh trực tiếp (oak_...) qua header Authorization: Bearer hoặc X-API-Key - dùng cho
//    .mcp.json/claude_desktop_config.json cấu hình tay (đã verify chạy tốt).
// 2. Access token do chính server này phát qua OAuth 2.1 (opaque, không phải oak_...) - dùng cho
//    nút "Add Custom Connector" trên Claude.ai/Desktop, tự chạy authorize+login+token.
function resolveApiKey(req: Request): string | null {
  const auth = req.headers["authorization"];
  let raw: string | null = null;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) raw = auth.slice(7).trim();
  else if (typeof req.headers["x-api-key"] === "string") raw = (req.headers["x-api-key"] as string).trim();
  if (!raw) return null;
  if (raw.startsWith("oak_")) return raw;
  return resolveIssuedToken(raw);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const oauthProvider = new McpAlOAuthProvider();
const ISSUER_URL = new URL(process.env.MCP_AL_OAUTH_ISSUER ?? "https://www.hanzomjp.com");
const RESOURCE_URL = new URL("/mcp-al", ISSUER_URL);

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: ISSUER_URL,
    resourceServerUrl: RESOURCE_URL,
    resourceName: "mcp-al",
    scopesSupported: [],
  })
);

// Nhận form đăng nhập (POST) từ trang login do oauthProvider.authorize() render - không phải
// endpoint chuẩn của SDK, chỉ để nối "nhập API key" với bước phát authorization code.
// Đặt tại /mcp-al/login (không phải /login gốc) vì domain này dùng chung với app thật -
// /login gốc là trang đăng nhập nhân viên (orderhangnhat-frontend), không được đụng vào.
app.post("/mcp-al/login", async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, resource, apiKey } = req.body ?? {};
  const fields = { client_id, redirect_uri, state: state ?? "", code_challenge, resource: resource ?? "" };
  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).type("html").send(renderLoginForm(fields, "Thiếu tham số - quay lại app và thử kết nối lại."));
  }
  if (!apiKey || !(await isValidApiKey(apiKey))) {
    return res.status(200).type("html").send(renderLoginForm(fields, "Sai hoặc thiếu API key."));
  }

  const code = randomUUID().replace(/-/g, "");
  codes.set(code, {
    apiKey,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    resource: resource ? new URL(resource) : undefined,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(302, redirect.href);
});

const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"];

  if (typeof sessionId === "string" && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (typeof sessionId !== "string" && isInitializeRequest(req.body)) {
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Thiếu API key - gửi header Authorization: Bearer <oak_...> hoặc đăng nhập OAuth" },
        id: null,
      });
      return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
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
  console.log(`mcp-al remote (Streamable HTTP + OAuth) listening on :${port} - issuer ${ISSUER_URL.href}`);
});
