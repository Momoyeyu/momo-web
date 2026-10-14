// backend REST 共享助手：JSON 收发 + 非 2xx 抛错（带 status）。
// 将来迁 Tauri 时只换这层实现为 invoke()。

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res;
}

export async function apiJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return (await apiFetch(path, init)).json() as Promise<T>;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
