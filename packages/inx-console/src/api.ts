export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Other fields of the error body, e.g. `resolved`/`expected` for DOMAIN_DNS_MISMATCH. */
    readonly data: Record<string, unknown> = {}
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
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'HTTP_' + res.status, data);
  return data as T;
}

export interface Status {
  initialized: boolean;
  authenticated: boolean;
  /** HTTPS via `inx-connect domain`. */
  tls: boolean;
  /** INX_PUBLIC_URL: the address devices use for subscriptions. */
  publicUrl: string | null;
}

export interface DomainStatus {
  domain: string | null;
  state: 'idle' | 'pending' | 'issued' | 'removed' | 'failed';
  requested: string | null;
  error: string | null;
  log: string | null;
  updatedAt: number | null;
}

const messages: Record<string, string> = {
  INVALID_SETUP_CODE: '初始化链接无效或已过期，请在主控主机上重新生成。',
  INVALID_PASSWORD: '密码不正确。',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请 15 分钟后再试。',
  NOT_INITIALIZED: '控制台尚未初始化。',
  INVALID_REQUEST: '输入不符合要求。',
  INVALID_NAME: '名称不能为空，且不超过 64 个字符。',
  INVALID_PAIR_CODE: '配对码格式不正确。请复制完整的 inx-pair-… 字符串。',
  GATEWAY_UNREACHABLE: '无法连接到这台 VPS。请确认 gateway 正在运行（sudo inx-gateway status），且防火墙放行了 TCP 3101。',
  GATEWAY_TIMEOUT: '连接 VPS 超时。请检查网络和防火墙设置。',
  GATEWAY_CERT_MISMATCH: '证书与配对码不符。若重新安装过 gateway，请在 VPS 上运行 sudo inx-gateway pair 获取新的配对码。',
  GATEWAY_AUTH: '配对码中的令牌已失效。请在 VPS 上运行 sudo inx-gateway pair 获取新的配对码。',
  GATEWAY_IDENTITY: '该地址上运行的是另一台 VPS 的 gateway。请为这台机器重新配对。',
  GATEWAY_RESPONSE: 'gateway 返回了无法识别的响应。请确认两端版本兼容。',
  NODE_MISMATCH: '这个配对码属于另一台 VPS，不能用于这台机器。',
  MACHINE_NOT_FOUND: '机器不存在或已被删除。',
  PANEL_AUTH: 'gateway 无法通过 3x-ui 面板鉴权。',
  PANEL_PERMISSION: '3x-ui 面板拒绝了 gateway 的请求。',
  PANEL_UNREACHABLE: 'gateway 无法连接本机的 3x-ui 面板，面板可能未运行。',
  PANEL_TIMEOUT: '3x-ui 面板响应超时。',
  PANEL_TLS: 'gateway 无法与 3x-ui 面板建立 TLS 连接。',
  PANEL_PATH: '3x-ui 面板地址或路径不正确。',
  PANEL_RESPONSE: '3x-ui 面板返回了无法识别的响应。',
  NODE_EXISTS: '这个客户端已经在列表中。',
  NODE_NOT_FOUND: '客户端记录不存在或已被删除。',
  INBOUND_NOT_FOUND: '入站已不在这台机器上，请先同步机器。',
  CLIENT_NOT_FOUND: '客户端已不在这个入站上，请先同步机器。',
  GATEWAY_UPGRADE_REQUIRED: '这台机器的 gateway 版本过旧，不提供客户端列表。请在 VPS 上重新运行安装脚本升级。',
  SUBSCRIPTION_NOT_FOUND: '订阅不存在或已被删除。',
  INVALID_MEMBERS: '订阅成员有重复，或超过 500 个。',
  DOMAIN_INVALID: '域名格式不正确。',
  DOMAIN_BUSY: '这台 VPS 正在处理上一个域名请求，请稍候。',
  DOMAIN_UNAVAILABLE: '这台 VPS 的 gateway 需要重新启动才能绑定域名。请在 VPS 上运行 sudo inx-gateway start。',
  DOMAIN_DNS_MISMATCH: '域名没有解析到这台 VPS。',
  DOMAIN_DNS_UNRESOLVED: 'VPS 上无法解析这个域名，请检查 DNS 记录。',
  DOMAIN_PORT_80_BUSY: 'VPS 的 80 端口被占用。申请证书需要临时使用 80 端口，请先停止占用它的程序。',
  DOMAIN_ACME_INSTALL_FAILED: '在 VPS 上安装 acme.sh 失败，请检查 VPS 能否访问外网。',
  DOMAIN_SOCAT_FAILED: '在 VPS 上安装 socat 失败。',
  DOMAIN_ACME_FAILED: '申请证书失败。请确认域名 A 记录指向这台 VPS，并且安全组和防火墙放行了 TCP 80。',
  DOMAIN_PANEL_FAILED: '证书已申请，但设置到 3x-ui 面板失败。',
  DOMAIN_TIMEOUT: '上一次申请没有完成就中断了，可以重新绑定。'
};

/** Short label for a machine's last error, for status badges. */
export function errorLabel(code: string) {
  if (code === 'GATEWAY_UNREACHABLE' || code === 'GATEWAY_TIMEOUT') return '离线';
  if (code === 'GATEWAY_CERT_MISMATCH' || code === 'GATEWAY_AUTH' || code === 'GATEWAY_IDENTITY') return '需要重新配对';
  if (code.startsWith('PANEL_')) return '面板异常';
  return '异常';
}

export const codeMessage = (code: string) => messages[code] ?? `请求失败（${code}）`;

export interface Machine {
  id: number;
  nodeId: string;
  name: string;
  endpoint: string;
  gatewayVersion: string;
  capabilities: string[];
  status: 'online' | 'error';
  lastError: string | null;
  inboundCount: number;
  syncedAt: number;
  checkedAt: number;
  createdAt: number;
  /** The VPS domain from its 3x-ui panel certificate; links use it. null: links use the IP. */
  domain: string | null;
}

export interface InboundClient {
  email: string;
  enabled: boolean;
  linkCount: number;
  unsupported: string | null;
  nodeId: number | null;
}

export interface Inbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enabled: boolean;
  /** null: the gateway predates client listing. */
  clients: InboundClient[] | null;
}

export interface MachineDetail {
  machine: Machine;
  inbounds: Inbound[];
  usage: { nodes: number; subscriptions: number };
}

export type NodeStatus = 'ok' | 'missing' | 'disabled' | 'unsupported' | 'unknown';

export interface Node {
  id: number;
  name: string;
  machineId: number;
  machineName: string;
  machineStatus: 'online' | 'error';
  inboundId: number;
  inboundRemark: string | null;
  protocol: string | null;
  port: number | null;
  clientEmail: string;
  status: NodeStatus;
  unsupported: string | null;
  linkCount: number;
  subscriptionCount: number;
  createdAt: number;
}

export interface Subscription {
  id: number;
  name: string;
  token: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubscriptionDetail {
  subscription: Subscription;
  nodes: Node[];
}

export interface PickerClient {
  email: string;
  enabled: boolean;
  unsupported: string | null;
  linkCount: number;
  nodeId: number | null;
  nodeName: string | null;
}

export interface PickerMachine {
  id: number;
  name: string;
  status: 'online' | 'error';
  clientsListed: boolean;
  inbounds: { id: number; remark: string; protocol: string; port: number; enabled: boolean; clients: PickerClient[] }[];
}

export interface ClientRef {
  machineId: number;
  inboundId: number;
  email: string;
}

export const clientKey = (r: ClientRef) => `${r.machineId}\n${r.inboundId}\n${r.email.toLowerCase()}`;

/** Subscription links use the controller's public URL when one is configured, else the address the console is open at. */
export const subscriptionUrl = (token: string, publicUrl: string | null | undefined) => (publicUrl ?? location.origin) + '/sub/' + token;

export const nodeStatusLabel: Record<NodeStatus, string> = { ok: '可用', missing: '已不存在', disabled: '已停用', unsupported: '不支持', unknown: '需升级 gateway' };

export const errorMessage = (e: unknown) => (e instanceof ApiError ? codeMessage(e.code) : '无法连接到服务器。');
