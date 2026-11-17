export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin'
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'HTTP_' + res.status);
  return data as T;
}

export interface Status {
  initialized: boolean;
  authenticated: boolean;
}

const messages: Record<string, string> = {
  INVALID_SETUP_CODE: '初始化链接无效或已过期，请在主控主机上重新生成。',
  INVALID_PASSWORD: '密码不正确。',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请 15 分钟后再试。',
  NOT_INITIALIZED: '控制台尚未初始化。',
  FST_ERR_VALIDATION: '输入不符合要求。'
};

export const errorMessage = (e: unknown) => (e instanceof ApiError ? (messages[e.code] ?? `请求失败（${e.code}）`) : '无法连接到服务器。');
