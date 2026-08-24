const BASE_URL = (process.env.MCP_AL_BASE_URL ?? "http://103.166.184.140/api").replace(/\/+$/, "");
const API_KEY = process.env.MCP_AL_API_KEY;

if (!API_KEY) {
  throw new Error("Thiếu MCP_AL_API_KEY - tạo API key ở /api/api-keys (đăng nhập bằng JWT) rồi đặt vào biến môi trường.");
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API trả lỗi ${status}: ${JSON.stringify(body)}`);
  }
}

export async function apiGet<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { "X-API-Key": API_KEY as string, Accept: "application/json" },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
