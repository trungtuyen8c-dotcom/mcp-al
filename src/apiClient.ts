// apiClient.ts — call the project's backend API with the API key (Bearer). Read-only (GET).
// Blocks cross-host SSRF, times out every request, never logs the key.

export interface ApiClientOpts { apiBase: string; apiKey: string; timeoutMs: number }

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export class ApiClient {
  private baseHost: string
  constructor(private cfg: ApiClientOpts) { this.baseHost = new URL(cfg.apiBase).host }

  // get — call one endpoint (path starts with '/'). Unwraps the `data` field if present.
  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(this.cfg.apiBase + path)
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    if (url.host !== this.baseHost) throw new ApiError('BAD_URL', 'target URL host differs from backend (SSRF)')

    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (e: any) {
      if (e?.name === 'TimeoutError') throw new ApiError('TIMEOUT', 'backend timeout')
      throw new ApiError('NETWORK', `could not reach backend: ${e?.message || 'network error'}`)
    }

    if (res.status === 401) throw new ApiError('UNAUTHORIZED', 'API key is invalid / revoked / expired')
    if (res.status === 403) throw new ApiError('FORBIDDEN', 'key is missing the required scope for this endpoint')
    if (res.status === 429) throw new ApiError('RATE_LIMITED', 'per-key requests/minute limit exceeded')
    if (res.status === 404) throw new ApiError('NOT_FOUND', 'endpoint does not exist on the backend')
    if (!res.ok) throw new ApiError('HTTP_' + res.status, `backend returned HTTP ${res.status}`)

    const body: any = await res.json().catch(() => null)
    if (body && typeof body === 'object' && 'data' in body) return body.data
    return body
  }
}
