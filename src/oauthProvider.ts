import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";

// Cầu nối OAuth 2.1 -> API key có sẵn của hệ thống. Không tạo tài khoản mới: nhân viên "đăng nhập"
// bằng đúng oak_... key họ đã có (từ /api/api-keys). Server này KHÔNG lưu mật khẩu/JWT - chỉ xác
// minh key còn hiệu lực bằng 1 lệnh gọi thử tới backend, rồi phát access token riêng của mcp-al
// map ngược lại đúng key đó. Toàn bộ state (client/code/token) lưu in-memory - restart server thì
// người dùng phải authorize lại (chấp nhận được, không phải hệ thống nhiều người dùng đồng thời lớn).

interface CodeEntry {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: URL;
  expiresAt: number;
}
interface TokenEntry {
  apiKey: string;
  clientId: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_SEC = 3600;

const clients = new Map<string, OAuthClientInformationFull>();
const codes = new Map<string, CodeEntry>();
const accessTokens = new Map<string, TokenEntry>();
const refreshTokens = new Map<string, { apiKey: string; clientId: string }>();

function sweepExpired() {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
}

export async function isValidApiKey(apiKey: string): Promise<boolean> {
  const base = (process.env.MCP_AL_BASE_URL ?? "http://103.166.184.140/api").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/customers?limit=1`, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
    // 401 = key sai/thu hồi/hết hạn. 403 vẫn là key hợp lệ, chỉ thiếu scope route này - chấp nhận.
    return res.status !== 401;
  } catch {
    return false;
  }
}

// Token do mcp-al tự phát (opaque, không phải oak_...) - dùng để tra ngược ra apiKey thật.
export function resolveIssuedToken(token: string): string | null {
  sweepExpired();
  const entry = accessTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.apiKey;
}

class McpAlClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string) {
    return clients.get(clientId);
  }
  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const client_id = randomUUID();
    const full = { ...client, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
    clients.set(client_id, full);
    return full;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderLoginForm(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>mcp-al - Đăng nhập</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; color: #1f2937; }
  h1 { font-size: 18px; }
  input[type="password"] { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 12px; width: 100%; padding: 10px; font-size: 14px; background: #4338ca; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
  .err { color: #b91c1c; font-size: 13px; margin-bottom: 8px; }
  .hint { color: #64748b; font-size: 12px; margin-top: 12px; }
</style></head>
<body>
  <h1>Đăng nhập mcp-al</h1>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/mcp-al/login">
    ${hidden}
    <input type="password" name="apiKey" placeholder="oak_..." autofocus required>
    <button type="submit">Đăng nhập</button>
  </form>
  <div class="hint">Dùng đúng API key của bạn (tạo ở /api/api-keys). Không phải mật khẩu tài khoản.</div>
</body></html>`;
}

export class McpAlOAuthProvider implements OAuthServerProvider {
  clientsStore: OAuthRegisteredClientsStore = new McpAlClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const html = renderLoginForm({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      state: params.state ?? "",
      code_challenge: params.codeChallenge,
      resource: params.resource?.href ?? "",
    });
    res.status(200).type("html").send(html);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    sweepExpired();
    const entry = codes.get(authorizationCode);
    if (!entry) throw new InvalidGrantError("Mã authorization code không hợp lệ hoặc đã hết hạn");
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    sweepExpired();
    const entry = codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Mã authorization code không hợp lệ");
    codes.delete(authorizationCode);

    const access_token = randomBytes(32).toString("hex");
    const refresh_token = randomBytes(32).toString("hex");
    accessTokens.set(access_token, { apiKey: entry.apiKey, clientId: client.client_id, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 });
    refreshTokens.set(refresh_token, { apiKey: entry.apiKey, clientId: client.client_id });

    return { access_token, token_type: "bearer", expires_in: TOKEN_TTL_SEC, refresh_token };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const entry = refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Refresh token không hợp lệ");
    const access_token = randomBytes(32).toString("hex");
    accessTokens.set(access_token, { apiKey: entry.apiKey, clientId: client.client_id, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 });
    return { access_token, token_type: "bearer", expires_in: TOKEN_TTL_SEC, refresh_token: refreshToken };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = accessTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) throw new InvalidTokenError("Access token không hợp lệ hoặc đã hết hạn");
    return { token, clientId: entry.clientId, scopes: [], expiresAt: Math.floor(entry.expiresAt / 1000), extra: { apiKey: entry.apiKey } };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    accessTokens.delete(request.token);
    refreshTokens.delete(request.token);
  }
}

export { renderLoginForm, codes, CODE_TTL_MS };
export type { CodeEntry };
