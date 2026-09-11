// config.ts — load + validate environment variables. Fail-fast on missing/unsafe values.
// Never logs key/secret values.
//
// Two transports:
//   - http  (online): the client (ChatGPT/Claude/agent) sends URL + API key per request.
//             → apiKey is NOT read from env; it comes from the Authorization/x-api-key header.
//   - stdio (local):  Claude Desktop runs this process; the key comes from env MCP_API_KEY.

export interface Config {
  apiBase: string
  timeoutMs: number
  transport: 'http' | 'stdio'
  port: number
  keyPrefix: string
  envApiKey?: string // stdio only
  // OAuth (http): enabled when BOTH oauthSecret + publicUrl are set → lets the ChatGPT app /
  // Claude web (OAuth-only, no field to paste an API key) connect. Header-key auth keeps working.
  oauthSecret?: string
  publicUrl?: string
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`[config] Missing required env var: ${name}. See .env.example.`)
    process.exit(1)
  }
  return v
}

export function loadConfig(): Config {
  const apiBase = requireEnv('MCP_API_BASE').replace(/\/+$/, '')
  let url: URL
  try { url = new URL(apiBase) } catch {
    console.error(`[config] MCP_API_BASE is not a valid URL: ${apiBase}`)
    process.exit(1)
  }
  // Allow http for INTERNAL hosts (localhost/127/docker service name with no dot).
  // Public hosts (with a dot) must use HTTPS so the key is never sent in the clear.
  const internal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || !url.hostname.includes('.')
  if (url.protocol !== 'https:' && !internal) {
    console.error('[config] A public MCP_API_BASE must use HTTPS (to avoid leaking the API key).')
    process.exit(1)
  }

  const transport = (process.env.MCP_TRANSPORT || 'http').toLowerCase() === 'stdio' ? 'stdio' : 'http'
  const port = Number(process.env.PORT) || 8787
  const timeoutMs = Number(process.env.MCP_HTTP_TIMEOUT_MS) || 10_000
  const keyPrefix = process.env.MCP_KEY_PREFIX?.trim() || ''

  const cfg: Config = { apiBase, timeoutMs, transport, port, keyPrefix }

  if (transport === 'stdio') {
    cfg.envApiKey = requireEnv('MCP_API_KEY')
    if (keyPrefix && !cfg.envApiKey.startsWith(keyPrefix)) {
      console.error(`[config] MCP_API_KEY has a wrong format (must start with "${keyPrefix}").`)
      process.exit(1)
    }
  }

  if (transport === 'http') {
    const oauthSecret = process.env.MCP_OAUTH_SECRET?.trim() || undefined
    const publicUrl = process.env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined
    if (oauthSecret) {
      if (oauthSecret.length < 16) { console.error('[config] MCP_OAUTH_SECRET is too short (>= 16 chars).'); process.exit(1) }
      if (!publicUrl) { console.error('[config] Enabling OAuth requires MCP_PUBLIC_URL (e.g. https://mcp.example.com).'); process.exit(1) }
      try { if (new URL(publicUrl).protocol !== 'https:') throw new Error() }
      catch { console.error('[config] MCP_PUBLIC_URL must be a valid HTTPS URL.'); process.exit(1) }
      cfg.oauthSecret = oauthSecret
      cfg.publicUrl = publicUrl
    }
  }

  return cfg
}
