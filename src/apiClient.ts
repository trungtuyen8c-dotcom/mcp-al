const DEFAULT_BASE_URL = (process.env.MCP_AL_BASE_URL ?? "http://103.166.184.140/api").replace(/\/+$/, "");

export interface ApiContext {
  apiKey: string;
  baseUrl?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API trả lỗi ${status}: ${JSON.stringify(body)}`);
  }
}

export async function apiGet<T>(
  ctx: ApiContext,
  path: string,
  query?: Record<string, string | undefined>
): Promise<T> {
  const base = (ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { "X-API-Key": ctx.apiKey, Accept: "application/json" },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
