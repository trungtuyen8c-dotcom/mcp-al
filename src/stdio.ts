// stdio.ts — local transport for Claude Desktop (single user). Key comes from env MCP_API_KEY.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'
import { ApiClient } from './apiClient.js'
import type { Config } from './config.js'
import { logInfo } from './audit.js'

export async function startStdio(cfg: Config) {
  const client = new ApiClient({ apiBase: cfg.apiBase, apiKey: cfg.envApiKey!, timeoutMs: cfg.timeoutMs })
  await buildServer(client).connect(new StdioServerTransport())
  logInfo('stdio MCP ready (key from env).')
}
