// Share links built from 3x-ui's inbound list, mirroring 3x-ui v3.11.0's subscription engine (internal/sub/service.go)
// for the protocols and transports INX Connect supports. The panel's own link endpoints are outside the node-sync token
// scope, and they do not say which inbound a link belongs to; building them here keeps every link tied to its inbound
// and client.
//
// Not reproduced (the client gets no links and an `unsupported` reason): mtproto, wireguard, amneziawg, tuic, kcp,
// and TCP finalmask. Also not reproduced: panel-managed Hosts, Hysteria gecko packet sizes, and the panel-wide
// subscription domain setting (links use the inbound's share address or else the Gateway's public host).
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

type Json = Record<string, unknown>;

export interface PanelClient {
  email: string;
  enable?: boolean;
  id?: string;
  password?: string;
  auth?: string;
  flow?: string;
  security?: string;
  subId?: string;
}

export interface PanelInbound {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  listen?: string;
  shareAddr?: string;
  shareAddrStrategy?: string;
  disableFlow?: boolean;
  settings: Json;
  streamSettings: Json;
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 3x-ui returns settings/streamSettings as nested objects since v3; older rows may still be JSON strings. */
export function parseJson(v: unknown): Json {
  if (typeof v === 'string') {
    try {
      return obj(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return obj(v);
}

// Go's url.QueryEscape: spaces become '+', and only A-Z a-z 0-9 - _ . ~ stay literal.
const queryEscape = (s: string) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
// 3x-ui's encodeURIComponent / encodeUserinfo: QueryEscape with %20 for spaces.
const componentEscape = (s: string) => queryEscape(s).replace(/\+/g, '%20');

// url.Values.Encode: keys sorted, QueryEscape on both sides.
function encodeParams(params: Map<string, string>) {
  return [...params.keys()]
    .sort()
    .map(k => queryEscape(k) + '=' + queryEscape(params.get(k)!))
    .join('&');
}

// Depth-first search for a key, as 3x-ui's searchKey (map iteration order aside).
function searchKey(data: unknown, key: string): unknown {
  if (Array.isArray(data)) {
    for (const v of data) {
      const found = searchKey(v, key);
      if (found !== undefined) return found;
    }
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (k === key) return v;
      const found = searchKey(v, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function searchHost(headers: unknown) {
  for (const [k, v] of Object.entries(obj(headers))) {
    if (k.toLowerCase() !== 'host') continue;
    return Array.isArray(v) ? str(v[0]) : str(v);
  }
  return '';
}

const isRoutable = (host: string) => host !== '' && !/^(0\.0\.0\.0|::|\[::\]|127\.|::1$|\[::1\]|localhost$)/i.test(host);

/** inbound share address: custom/listen strategies, a routable listen address, else the Gateway's public host. */
export function inboundAddress(inbound: PanelInbound, publicHost: string) {
  const listen = inbound.listen && !inbound.listen.startsWith('@') && !inbound.listen.startsWith('/') && isRoutable(inbound.listen) ? inbound.listen : '';
  const candidates = inbound.shareAddrStrategy === 'custom' ? [str(inbound.shareAddr).trim(), listen] : [listen];
  return candidates.find(c => c !== '') ?? publicHost;
}

const joinHostPort = (host: string, port: number) => {
  const bare = host.replace(/^\[|\]$/g, '');
  return (isIP(bare) === 6 ? '[' + bare + ']' : bare) + ':' + port;
};

function pathAndHost(settings: Json, put: (k: string, v: string) => void) {
  put('path', str(settings.path));
  put('host', str(settings.host) || searchHost(settings.headers));
}

function tcpHttpHeader(stream: Json, put: (k: string, v: string) => void) {
  const header = obj(obj(stream.tcpSettings).header);
  if (header.type !== 'http') return false;
  const request = obj(header.request);
  const path = list(request.path);
  if (path.length > 0) put('path', str(path[0]));
  put('host', searchHost(obj(obj(header.response).headers)) || searchHost(request.headers));
  return true;
}

const xhttpDefaults: Record<string, string> = { scMaxEachPostBytes: '1000000', scMinPostsIntervalMs: '30' };
function xhttpExtra(xhttp: Json) {
  const extra: Json = {};
  if (str(xhttp.mode)) extra.mode = xhttp.mode;
  if (str(xhttp.xPaddingBytes)) extra.xPaddingBytes = xhttp.xPaddingBytes;
  if (xhttp.xPaddingObfsMode === true) {
    extra.xPaddingObfsMode = true;
    for (const f of ['xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod']) if (str(xhttp[f])) extra[f] = xhttp[f];
  }
  for (const f of ['uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'sessionIDLength', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'scMaxEachPostBytes', 'scMinPostsIntervalMs']) {
    const v = str(xhttp[f]);
    if (v && v !== xhttpDefaults[f]) extra[f] = v;
  }
  for (const [legacy, renamed] of [
    ['sessionPlacement', 'sessionIDPlacement'],
    ['sessionKey', 'sessionIDKey']
  ] as const)
    if (extra[renamed] === undefined && str(xhttp[legacy])) extra[renamed] = xhttp[legacy];
  if (str(extra.sessionIDPlacement)) extra.sessionPlacement = extra.sessionIDPlacement;
  if (str(extra.sessionIDKey)) extra.sessionKey = extra.sessionIDKey;
  const chunk = xhttp.uplinkChunkSize;
  if ((typeof chunk === 'number' && chunk !== 0) || (typeof chunk === 'string' && chunk !== '' && chunk !== '0')) extra.uplinkChunkSize = chunk;
  if (xhttp.noGRPCHeader === true) extra.noGRPCHeader = true;
  for (const f of ['xmux', 'downloadSettings']) if (Object.keys(obj(xhttp[f])).length > 0) extra[f] = xhttp[f];
  const headers = Object.fromEntries(Object.entries(obj(xhttp.headers)).filter(([k]) => k.toLowerCase() !== 'host'));
  if (Object.keys(headers).length > 0) extra.headers = headers;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** type/path/host/serviceName/... for URL-style links (applyShareNetworkParams). */
function networkParams(stream: Json, network: string, params: Map<string, string>) {
  const put = (k: string, v: string) => params.set(k, v);
  switch (network) {
    case 'tcp':
      if (tcpHttpHeader(stream, put)) params.set('headerType', 'http');
      break;
    case 'ws':
      pathAndHost(obj(stream.wsSettings), put);
      break;
    case 'grpc': {
      const grpc = obj(stream.grpcSettings);
      params.set('serviceName', str(grpc.serviceName));
      params.set('authority', str(grpc.authority));
      if (grpc.multiMode === true) params.set('mode', 'multi');
      break;
    }
    case 'httpupgrade':
      pathAndHost(obj(stream.httpupgradeSettings), put);
      break;
    case 'xhttp': {
      const xhttp = obj(stream.xhttpSettings);
      pathAndHost(xhttp, put);
      if (typeof xhttp.mode === 'string') params.set('mode', xhttp.mode);
      if (str(xhttp.xPaddingBytes)) params.set('x_padding_bytes', str(xhttp.xPaddingBytes));
      const extra = xhttpExtra(xhttp);
      if (extra) params.set('extra', JSON.stringify(extra));
      break;
    }
  }
}

const pins = (v: unknown) => list(v).filter((p): p is string => typeof p === 'string' && p !== '');

function tlsFields(stream: Json) {
  const tls = obj(stream.tlsSettings);
  const inner = searchKey(tls, 'settings');
  const alpn = list(tls.alpn).filter(a => typeof a === 'string') as string[];
  return {
    alpn: alpn.join(','),
    sni: str(searchKey(tls, 'serverName')),
    fp: str(searchKey(inner, 'fingerprint')),
    ech: str(searchKey(inner, 'echConfigList')),
    cs: str(searchKey(tls, 'cipherSuites')),
    vcn: str(searchKey(inner, 'verifyPeerCertByName')).trim(),
    pins: pins(searchKey(inner, 'pinnedPeerCertSha256'))
  };
}

function tlsParams(stream: Json, params: Map<string, string>) {
  params.set('security', 'tls');
  const t = tlsFields(stream);
  if (t.alpn) params.set('alpn', t.alpn);
  if (searchKey(obj(stream.tlsSettings), 'serverName') !== undefined) params.set('sni', t.sni);
  if (searchKey(searchKey(obj(stream.tlsSettings), 'settings'), 'fingerprint') !== undefined) params.set('fp', t.fp);
  if (t.ech) params.set('ech', t.ech);
  if (t.vcn) params.set('vcn', t.vcn);
  if (t.pins.length > 0) params.set('pcs', t.pins.join(','));
  if (t.cs) params.set('cs', t.cs);
}

// External proxy TLS overrides (applyExternalProxyTLSParams), applied when the endpoint ends up on TLS.
function endpointTls(ep: Json, set: (k: string, v: string) => void) {
  if (str(ep.sni)) set('sni', str(ep.sni));
  if (str(ep.fingerprint)) set('fp', str(ep.fingerprint));
  const alpn = Array.isArray(ep.alpn) ? ep.alpn.filter(a => typeof a === 'string' && a).join(',') : str(ep.alpn);
  if (alpn) set('alpn', alpn);
  if (pins(ep.pinnedPeerCertSha256).length > 0) set('pcs', pins(ep.pinnedPeerCertSha256).join(','));
  if (str(ep.verifyPeerCertByName)) set('vcn', str(ep.verifyPeerCertByName));
  if (str(ep.echConfigList)) set('ech', str(ep.echConfigList));
  if (str(ep.cipherSuites)) set('cs', str(ep.cipherSuites));
}

// 3x-ui picks a random serverName/shortId per request; the first ones keep links stable between syncs.
function realityParams(stream: Json, params: Map<string, string>, clientKey: string) {
  params.set('security', 'reality');
  const reality = obj(stream.realitySettings);
  const inner = searchKey(reality, 'settings');
  const names = list(searchKey(reality, 'serverNames'));
  if (names.length > 0) params.set('sni', str(names[0]));
  const pbk = searchKey(inner, 'publicKey');
  if (pbk !== undefined) params.set('pbk', str(pbk));
  const sids = list(searchKey(reality, 'shortIds'));
  if (sids.length > 0) params.set('sid', str(sids[0]));
  if (str(searchKey(inner, 'fingerprint'))) params.set('fp', str(searchKey(inner, 'fingerprint')));
  if (str(searchKey(inner, 'mldsa65Verify'))) params.set('pqv', str(searchKey(inner, 'mldsa65Verify')));
  const seed = str(searchKey(inner, 'spiderX'));
  // deriveSpiderX: deterministic per client so links do not change on every sync.
  const digest = createHash('sha256')
    .update(seed + '|' + clientKey)
    .digest('hex')
    .slice(0, 15);
  const query = seed.includes('?') ? seed.slice(seed.indexOf('?') + 1) : '';
  params.set('spx', '/' + digest + (query ? '?' + query : ''));
}

const realityOnly = ['pbk', 'sid', 'spx', 'pqv'];

interface Endpoint {
  address: string;
  port: number;
  /** Security for this endpoint: the inbound's own, or an external proxy's forced choice. */
  security: string;
  ep?: Json;
}

function endpoints(inbound: PanelInbound, stream: Json, publicHost: string, security: string): Endpoint[] {
  const proxies = list(stream.externalProxy)
    .map(obj)
    .filter(ep => str(ep.dest) && typeof ep.port === 'number');
  if (proxies.length === 0) return [{ address: inboundAddress(inbound, publicHost), port: inbound.port, security }];
  return proxies.map(ep => {
    const force = str(ep.forceTls);
    return { address: str(ep.dest), port: ep.port as number, security: force && force !== 'same' ? force : security, ep };
  });
}

// buildEndpointLinks: per-endpoint security override, endpoint TLS overrides, and TLS fields dropped for forceTls "none".
function urlLink(base: string, params: Map<string, string>, baseSecurity: string, e: Endpoint, remark: string) {
  const p = new Map(params);
  if (e.ep) {
    if (baseSecurity === 'reality' && e.security !== 'reality') for (const k of realityOnly) p.delete(k);
    if (e.security === 'tls') endpointTls(e.ep, (k, v) => p.set(k, v));
    p.set('security', e.security);
    if (e.ep.forceTls === 'none') for (const k of ['alpn', 'sni', 'fp', 'pcs', 'cs']) p.delete(k);
  }
  if (p.get('cs') && !p.get('fp')) p.set('fp', 'unsafe');
  const query = encodeParams(p);
  return base + joinHostPort(e.address, e.port) + (query ? '?' + query : '') + (remark ? '#' + componentEscape(remark) : '');
}

// genRemark's default shape: inbound remark, endpoint remark, client email.
const remarkFor = (inbound: PanelInbound, client: PanelClient, e: Endpoint) => [inbound.remark, str(e.ep?.remark), client.email].filter(Boolean).join('-');

function vlessFlowAllowed(network: string, security: string, settings: Json) {
  if (network === 'tcp' && (security === 'tls' || security === 'reality')) return true;
  return ['encryption', 'decryption'].some(k => str(settings[k]) !== '' && settings[k] !== 'none');
}

function urlStyle(inbound: PanelInbound, client: PanelClient, publicHost: string): string[] {
  const stream = inbound.streamSettings;
  const settings = inbound.settings;
  const network = str(stream.network);
  const security = str(stream.security);
  const params = new Map<string, string>([['type', network]]);
  let scheme: string;
  let user: string;
  switch (inbound.protocol) {
    case 'vless':
      scheme = 'vless';
      user = str(client.id);
      params.set('encryption', str(settings.encryption) || 'none');
      break;
    case 'trojan':
      scheme = 'trojan';
      user = componentEscape(str(client.password));
      break;
    default: {
      scheme = 'ss';
      const method = str(settings.method);
      user = method.startsWith('2022') ? [method, str(settings.password), str(client.password)].map(queryEscape).join(':') : Buffer.from(method + ':' + str(client.password)).toString('base64url');
    }
  }
  networkParams(stream, network, params);
  if (security === 'tls') tlsParams(stream, params);
  else if (security === 'reality' && inbound.protocol !== 'shadowsocks') {
    realityParams(stream, params, client.subId || client.email);
    if (inbound.protocol === 'vless') params.set('support-x25519mlkem768', 'true');
  } else if (inbound.protocol !== 'shadowsocks') params.set('security', 'none');
  if (inbound.protocol === 'vless' && client.flow && !inbound.disableFlow && vlessFlowAllowed(network, security, settings)) params.set('flow', client.flow);
  if (inbound.protocol === 'trojan' && security === 'reality' && network === 'tcp' && client.flow && !inbound.disableFlow) params.set('flow', client.flow);
  if (inbound.protocol === 'shadowsocks' && network === 'tcp' && params.get('headerType') === 'http') {
    // SIP002 clients only read `plugin`: re-encode the TCP http header as obfs-local.
    const host = params.get('host') ?? '';
    for (const k of ['type', 'headerType', 'host', 'path']) params.delete(k);
    params.set('plugin', 'obfs-local;obfs=http;obfs-host=' + host);
  }
  return endpoints(inbound, stream, publicHost, security).map(e => urlLink(scheme + '://' + user + '@', params, security, e, remarkFor(inbound, client, e)));
}

function vmess(inbound: PanelInbound, client: PanelClient, publicHost: string): string[] {
  const stream = inbound.streamSettings;
  const network = str(stream.network);
  const security = str(stream.security);
  const base: Json = { v: '2', port: inbound.port, type: 'none', net: network };
  const put = (k: string, v: string) => (base[k] = v);
  switch (network) {
    case 'tcp': {
      const header = obj(obj(stream.tcpSettings).header);
      base.type = str(header.type);
      tcpHttpHeader(stream, put);
      break;
    }
    case 'ws':
      pathAndHost(obj(stream.wsSettings), put);
      break;
    case 'grpc': {
      const grpc = obj(stream.grpcSettings);
      base.path = str(grpc.serviceName);
      base.authority = str(grpc.authority);
      if (grpc.multiMode === true) base.type = 'multi';
      break;
    }
    case 'httpupgrade':
      pathAndHost(obj(stream.httpupgradeSettings), put);
      break;
    case 'xhttp': {
      const xhttp = obj(stream.xhttpSettings);
      pathAndHost(xhttp, put);
      if (typeof xhttp.mode === 'string') base.mode = xhttp.mode;
      const extra = xhttpExtra(xhttp);
      if (extra) base.extra = extra;
      break;
    }
  }
  base.tls = security;
  if (security === 'tls') {
    const t = tlsFields(stream);
    if (t.alpn) base.alpn = t.alpn;
    if (searchKey(obj(stream.tlsSettings), 'serverName') !== undefined) base.sni = t.sni;
    if (searchKey(searchKey(obj(stream.tlsSettings), 'settings'), 'fingerprint') !== undefined) base.fp = t.fp;
    if (t.ech) base.ech = t.ech;
    if (t.vcn) base.vcn = t.vcn;
    if (t.pins.length > 0) base.pcs = t.pins.join(',');
    if (t.cs) base.cs = t.cs;
  }
  base.id = str(client.id);
  base.scy = ['', 'none', 'zero'].includes(str(client.security)) ? 'auto' : client.security;
  return endpoints(inbound, stream, publicHost, security).map(e => {
    const tlsOnly = new Set(['alpn', 'sni', 'fp', 'pcs', 'vcn', 'ech', 'cs']);
    // An endpoint that drops TLS also drops every TLS field.
    const o: Json = Object.fromEntries(Object.entries({ ...base, add: e.address, port: e.port }).filter(([k]) => !(e.ep && e.security !== 'tls' && tlsOnly.has(k))));
    if (e.ep) {
      o.tls = e.security;
      if (e.security === 'tls') endpointTls(e.ep, (k, v) => (o[k] = v));
    }
    if (str(o.cs) && !str(o.fp)) o.fp = 'unsafe';
    o.ps = remarkFor(inbound, client, e);
    // Go's json.MarshalIndent sorts map keys.
    const sorted = Object.fromEntries(
      Object.keys(o)
        .sort()
        .map(k => [k, o[k]])
    );
    return 'vmess://' + Buffer.from(JSON.stringify(sorted, null, 2)).toString('base64');
  });
}

// Hysteria clients expect hex SHA-256 pins; base64 pins of 32 bytes are converted.
function hysteriaPin(pin: string) {
  const raw = Buffer.from(pin, 'base64');
  return raw.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(pin) ? raw.toString('hex') : pin;
}

function hysteria(inbound: PanelInbound, client: PanelClient, publicHost: string): string[] {
  const stream = inbound.streamSettings;
  const params = new Map<string, string>([['security', 'tls']]);
  const t = tlsFields(stream);
  if (t.alpn) params.set('alpn', t.alpn);
  if (searchKey(obj(stream.tlsSettings), 'serverName') !== undefined) params.set('sni', t.sni);
  if (searchKey(searchKey(obj(stream.tlsSettings), 'settings'), 'fingerprint') !== undefined) params.set('fp', t.fp);
  if (t.ech) params.set('ech', t.ech);
  if (t.vcn) params.set('vcn', t.vcn);
  if (t.pins.length > 0) params.set('pinSHA256', t.pins.map(hysteriaPin).join(','));
  for (const mask of list(obj(stream.finalmask).udp).map(obj)) {
    const pw = str(obj(mask.settings).password);
    if (mask.type === 'salamander' && pw) {
      params.set('obfs', 'salamander');
      params.set('obfs-password', pw);
      break;
    }
  }
  const finalmask = obj(stream.finalmask);
  const hop = str(obj(obj(finalmask.quicParams).udpHop).ports).trim();
  if (hop) params.set('mport', hop);
  const scheme = Number(inbound.settings.version) === 1 ? 'hysteria' : 'hysteria2';
  return endpoints(inbound, stream, publicHost, 'tls').map(e => {
    const p = new Map(params);
    // Hysteria keeps its own endpoint path: TLS overrides, but pins go out as hex pinSHA256, never pcs.
    if (e.ep)
      endpointTls(e.ep, (k, v) => {
        if (k === 'pcs') p.set('pinSHA256', v.split(',').map(hysteriaPin).join(','));
        else if (k !== 'cs') p.set(k, v);
      });
    const query = encodeParams(p);
    return scheme + '://' + componentEscape(str(client.auth)) + '@' + joinHostPort(e.address, e.port) + (query ? '?' + query : '') + '#' + componentEscape(remarkFor(inbound, client, e));
  });
}

/** Share links for one client of one inbound, or the reason none can be built here. */
export function clientLinks(inbound: PanelInbound, client: PanelClient, publicHost: string): { links: string[] } | { unsupported: string } {
  if (str(inbound.streamSettings.network) === 'xdrive') return { unsupported: 'transport:xdrive' };
  if (str(inbound.streamSettings.network) === 'kcp') return { unsupported: 'transport:kcp' };
  if (list(obj(inbound.streamSettings.finalmask).tcp).length > 0) return { unsupported: 'finalmask' };
  switch (inbound.protocol) {
    case 'vless':
    case 'trojan':
    case 'shadowsocks':
      return { links: urlStyle(inbound, client, publicHost) };
    case 'vmess':
      return { links: vmess(inbound, client, publicHost) };
    case 'hysteria':
      return { links: hysteria(inbound, client, publicHost) };
    default:
      return { unsupported: 'protocol:' + inbound.protocol };
  }
}
