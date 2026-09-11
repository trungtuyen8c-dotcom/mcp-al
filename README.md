# mcp-al-mcp

MCP server for **mcp-al** — the bridge between AI agents (Claude, ChatGPT, your own
agent) and the project's API. Each tool calls one `/ext/*` endpoint, authenticated with
an API key + scopes.

## Run
```bash
cp .env.example .env      # fill MCP_API_BASE
npm install && npm run build
MCP_TRANSPORT=http PORT=8787 npm start   # POST /mcp ; health: GET /health
```

## Connect
- **Header key** (Claude Desktop/curl/API): `Authorization: Bearer <key>` or `x-api-key: <key>`.
- **OAuth** (ChatGPT app / Claude web): set `MCP_OAUTH_SECRET` + `MCP_PUBLIC_URL` → the client discovers OAuth → key consent page.

## Add a tool
1. Backend: add a `/ext/<path>` route requiring the matching scope (see API-KEY-BACKEND-GUIDE.md).
2. MCP: add a `readTool(...)` in `src/server.ts`, then rebuild.

## Structure
```
src/index.ts     transport selector
src/config.ts    load/validate env
src/apiClient.ts call backend + Bearer, SSRF block, timeout
src/server.ts    register tools  ← EDIT HERE
src/http.ts      Streamable HTTP (verify-at-init, cap/TTL, IP-limit, key-bind)
src/oauth.ts     stateless OAuth 2.0 (for ChatGPT/Claude web)
src/stdio.ts     local transport
src/audit.ts     stderr logging, secrets redacted
```
