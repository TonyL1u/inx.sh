import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { type Config, gatewayUrl, matchesHost, pair, readConfig, saveConfig, secret } from './config.js';
import { listInbounds, PanelError, panelUrl } from './panel.js';

export const defaultDir = '/etc/inx-gateway';

function run(bin: string, args: string[], label: string, cwd?: string) {
  try {
    return execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000 });
  } catch {
    throw Error(label + ' failed. Check executable, permissions and configuration.');
  }
}
function tls(dir: string, endpoint: string, old?: Config) {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  if (old && matchesHost(old.cert, host)) return { cert: old.cert, key: old.key };
  const tmp = mkdtempSync(join(dir, 'tls-'));
  try {
    // Self-signed: the pairing code pins this certificate, so there is no CA.
    const san = 'subjectAltName=' + (isIP(host) ? 'IP:' : 'DNS:') + host;
    run(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '3650', '-keyout', 'server.key', '-out', 'server.pem', '-subj', '/CN=INX Gateway', '-addext', 'extendedKeyUsage=serverAuth', '-addext', san],
      'OpenSSL',
      tmp
    );
    return { cert: readFileSync(join(tmp, 'server.pem'), 'utf8'), key: readFileSync(join(tmp, 'server.key'), 'utf8') };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultEndpoint() {
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter(x => x && !x.internal && x.family === 'IPv4')
        .map(x => x!.address)
        .filter(ip => !/^(0\.|10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip))
    )
  ];
  if (addresses.length !== 1) throw Error('Cannot determine a unique public IPv4 address on this VPS.');
  return 'https://' + addresses[0] + ':3101';
}

function checkGateway(c: Config) {
  const url = new URL(c.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<void>((resolve, reject) => {
    const req = get(
      {
        hostname: host.includes(':') ? '::1' : '127.0.0.1',
        port: url.port || 443,
        path: '/v1/info',
        ca: c.cert,
        servername: isIP(host) ? undefined : host,
        checkServerIdentity: (_, cert) => checkServerIdentity(host, cert),
        headers: { authorization: 'Bearer ' + c.token },
        signal: AbortSignal.timeout(2000)
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode === 200 && JSON.parse(text).id === c.id) return resolve();
          } catch {
            return reject(Error('Malformed Gateway identity response'));
          }
          reject(Error('Gateway identity or authentication failed'));
        });
      }
    );
    req.on('error', reject);
  });
}

function systemService() {
  const paths = [process.execPath, fileURLToPath(new URL('./index.js', import.meta.url))];
  if (paths.some(p => !/^\/[A-Za-z0-9_./@+-]+$/.test(p) || /^\/(?:home|root|tmp)\//.test(p))) throw Error('Install Node and Gateway system-wide, outside home and temporary directories.');
  writeFileSync(
    '/etc/systemd/system/inx-gateway.service',
    [
      '[Unit]',
      'Description=INX Gateway',
      'After=network.target x-ui.service',
      '',
      '[Service]',
      'DynamicUser=yes',
      'LoadCredential=config.json:/etc/inx-gateway/config.json',
      'ExecStart=' + paths.join(' ') + ' serve',
      'Restart=on-failure',
      'RestartSec=2',
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      'ProtectHome=yes',
      'ProtectSystem=strict',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n'),
    { mode: 0o644 }
  );
  for (const args of [['daemon-reload'], ['enable', 'inx-gateway'], ['restart', 'inx-gateway']]) run('systemctl', args, 'systemctl ' + args.join(' '));
}

export async function setup() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Service setup requires Linux/systemd and root.');
  const dir = defaultDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) throw Error('State directory must be owned by the operator and mode 0700.');
  const lock = join(dir, '.setup-lock');
  mkdirSync(lock);
  try {
    const cfgPath = join(dir, 'config.json');
    const old = existsSync(cfgPath) ? readConfig(cfgPath) : undefined;
    const endpoint = gatewayUrl(old?.endpoint ?? defaultEndpoint());
    const bin = '/usr/local/x-ui/x-ui';
    const fresh = !old && !existsSync(bin);
    if (fresh) {
      execFileSync('/bin/bash', [fileURLToPath(new URL('../scripts/install-panel.sh', import.meta.url))], { stdio: ['ignore', 2, 2], timeout: 300000 });
    }
    let panelToken = old?.panel.token;
    let address = old?.panel.url;
    if (!address || !panelToken) {
      if (!existsSync(bin)) throw Error('Native 3x-ui panel not found.');
      if (!/^v?3\.11\.0$/.test(run(bin, ['-v'], '3x-ui version').trim())) throw Error('Automatic panel discovery requires 3x-ui v3.11.0. No panel settings changed.');
    }
    if (!address) {
      const info = run(bin, ['setting', '-show'], 'Read panel settings');
      const port = /^port:\s*(\d+)\s*$/m.exec(info)?.[1],
        path = /^webBasePath:[ \t]*(\/[^\r\n]*)/m.exec(info)?.[1];
      if (!port || !path) throw Error('Cannot determine the local panel port or base path.');
      address = (info.includes('Panel is secure with SSL') ? 'https' : 'http') + '://127.0.0.1:' + port + path.trim();
    }
    const url = panelUrl(address);
    const pem = tls(dir, endpoint, old);
    const id = old?.id ?? randomUUID();
    const pending = join(dir, 'pending-panel-token');
    if (!panelToken && existsSync(pending)) panelToken = readFileSync(pending, 'utf8').trim();
    if (!panelToken) {
      const stdout = run(bin, ['setting', '-getApiToken', '-tokenName', 'inx-' + id, '-tokenScope', 'node-sync'], 'Mint panel token');
      panelToken = /^apiToken:[ \t]*(\S+)\s*$/m.exec(stdout)?.[1];
      if (!panelToken) throw Error('3x-ui did not issue a token.');
      writeFileSync(pending, panelToken, { mode: 0o600, flag: 'wx' });
    }
    const panel = { ...old?.panel, url, token: panelToken };
    for (let attempt = 0; ; attempt++) {
      try {
        await listInbounds(panel);
        break;
      } catch (e) {
        if (!fresh || attempt >= 20 || !(e instanceof PanelError) || e.code !== 'PANEL_UNREACHABLE') throw e;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    const token = old && Buffer.from(old.token, 'base64url').length === 16 ? old.token : secret(16);
    const config = { id, endpoint, token, panel, ...pem };
    saveConfig(dir, config);
    if (existsSync(pending)) rmSync(pending);
    systemService();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await checkGateway(config);
        return pair(config);
      } catch {
        await new Promise(r => setTimeout(r, 250));
      }
    }
    throw Error('Gateway did not become ready within 30 seconds. Inspect journalctl -u inx-gateway; rerun setup after correcting the issue.');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
