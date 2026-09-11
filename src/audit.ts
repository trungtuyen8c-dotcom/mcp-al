// audit.ts — log to STDERR (stdout is the MCP JSON-RPC channel). Redacts secrets.
const REDACT = ['password', 'token', 'secret', 'api_key', 'apikey', 'authorization', 'key']

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      o[k] = REDACT.some(r => k.toLowerCase().includes(r)) ? '[REDACTED]' : redact(val)
    return o
  }
  return v
}

export function auditToolCall(e: {
  tool: string; params: Record<string, unknown>
  result: 'success' | 'error'; durationMs: number; error?: string
}) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...e, params: redact(e.params) }) + '\n')
}

export function logInfo(m: string) { process.stderr.write(`[mcp] ${m}\n`) }
