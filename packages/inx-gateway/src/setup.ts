import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { type Config, gatewayUrl, matchesHost, pair, readConfig, saveConfig, secret } from './config.js';
import { choosePort, defaultInbound } from './default-inbound.js';
import { addInbound, listInbounds, PanelError, panelUrl } from './panel.js';

export const defaultDir = '/etc/inx-gateway';
// Survives uninstall, so a reinstalled node keeps its identity and the controller can re-pair it in place.
export const nodeIdFile = '/var/lib/inx-gateway/node-id';

// The x-ui management menu from the 3x-ui release, as its own installer provides it. Only for panels start() installed.
function installXuiCommand() {
  const script = '/usr/local/x-ui/x-ui.sh';
  if (existsSync('/usr/bin/x-ui') || !existsSync(script)) return;
  copyFileSync(script, '/usr/bin/x-ui');
  chmodSync('/usr/bin/x-ui', 0o755);
}

function rememberedNodeId() {
  try {
    const id = readFileSync(nodeIdFile, 'utf8').trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
function rememberNodeId(id: string) {
  if (rememberedNodeId() === id) return;
  mkdirSync('/var/lib/inx-gateway', { recursive: true, mode: 0o700 });
  writeFileSync(nodeIdFile + '.tmp', id + '\n', { mode: 0o600 });
  renameSync(nodeIdFile + '.tmp', nodeIdFile);
}

const say = (s: string) => console.error('==> ' + s);

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
      'ExecStart=' + paths.join(' '),
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

export async function start() {
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
      writeFileSync(join(dir, 'panel-managed'), '', { mode: 0o600 });
    }
    if (existsSync(join(dir, 'panel-managed'))) installXuiCommand();
    let panelToken = old?.panel.token;
    let address = old?.panel.url;
    if (!address || !panelToken) {
      if (!existsSync(bin)) throw Error('Native 3x-ui panel not found.');
      if (!/^v?3\.11\.0$/.test(run(bin, ['-v'], '3x-ui version').trim())) throw Error('Automatic panel discovery requires 3x-ui v3.11.0. No panel settings changed.');
    }
    const discover = () => {
      const info = run(bin, ['setting', '-show'], 'Read panel settings');
      const port = /^port:\s*(\d+)\s*$/m.exec(info)?.[1],
        path = /^webBasePath:[ \t]*(\/[^\r\n]*)/m.exec(info)?.[1];
      if (!port || !path) throw Error('Cannot determine the local panel port or base path.');
      return (info.includes('Panel is secure with SSL') ? 'https' : 'http') + '://127.0.0.1:' + port + path.trim();
    };
    // Follow the panel on every start: its port or base path may have changed (for example from the x-ui menu).
    if (!address) address = discover();
    else if (existsSync(bin)) {
      try {
        address = discover();
      } catch {
        // Keep the stored address; the connection check below reports a real problem.
      }
    }
    const url = panelUrl(address);
    const pem = tls(dir, endpoint, old);
    const id = old?.id ?? rememberedNodeId() ?? randomUUID();
    rememberNodeId(id);
    const pending = join(dir, 'pending-panel-token');
    if (!panelToken && existsSync(pending)) panelToken = readFileSync(pending, 'utf8').trim();
    const mint = () => {
      const stdout = run(bin, ['setting', '-getApiToken', '-tokenName', 'inx-' + id, '-tokenScope', 'node-sync'], 'Mint panel token');
      const minted = /^apiToken:[ \t]*(\S+)\s*$/m.exec(stdout)?.[1];
      if (!minted) throw Error('3x-ui did not issue a token.');
      rmSync(pending, { force: true });
      writeFileSync(pending, minted, { mode: 0o600, flag: 'wx' });
      return minted;
    };
    panelToken ??= mint();
    const panel = { ...old?.panel, url, token: panelToken };
    // A stored token stops working if the panel's settings were reset; issue a new one once.
    let reminted = !old;
    if (fresh) say('Waiting for the panel to accept connections');
    for (let attempt = 0; ; attempt++) {
      try {
        await listInbounds(panel);
        break;
      } catch (e) {
        if (!reminted && e instanceof PanelError && e.code === 'PANEL_AUTH' && existsSync(bin)) {
          say('The stored panel token was rejected; issuing a new one');
          panel.token = mint();
          reminted = true;
          continue;
        }
        if (!fresh || attempt >= 20 || !(e instanceof PanelError) || e.code !== 'PANEL_UNREACHABLE') throw e;
        process.stderr.write('.');
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (fresh) process.stderr.write('\n');
    // A panel we just installed has no inbounds: create one so the node is usable right after pairing.
    let created: string | undefined;
    if (fresh) {
      try {
        const existing = await listInbounds(panel);
        if (existing.length === 0) {
          const port = await choosePort(existing.map(i => i.port));
          say('Creating a default VLESS + Reality inbound on TCP port ' + port);
          await addInbound(panel, defaultInbound(port));
          created = 'Created a VLESS + Reality inbound on TCP port ' + port + '. Allow inbound TCP ' + port + ' in your firewall or security group.';
        }
      } catch (e) {
        process.stderr.write('warning: could not create the default inbound (' + (e instanceof Error ? e.message : 'unknown error') + '). Create one with sudo x-ui or the panel.\n');
      }
    }
    const token = old && Buffer.from(old.token, 'base64url').length === 16 ? old.token : secret(16);
    const config = { id, endpoint, token, panel, ...pem };
    saveConfig(dir, config);
    if (existsSync(pending)) rmSync(pending);
    say('Installing the gateway systemd service');
    systemService();
    say('Waiting for the gateway to come up (up to 30 seconds)');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await checkGateway(config);
        process.stderr.write('\n');
        if (created) say(created);
        return pair(config);
      } catch {
        process.stderr.write('.');
        await new Promise(r => setTimeout(r, 250));
      }
    }
    throw Error('Gateway did not become ready within 30 seconds. Inspect journalctl -u inx-gateway; rerun start after correcting the issue.');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function stop() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Service control requires Linux/systemd and root.');
  if (!existsSync('/etc/systemd/system/inx-gateway.service')) throw Error('Gateway service is not installed. Run inx-gateway start first.');
  run('systemctl', ['stop', 'inx-gateway'], 'systemctl stop inx-gateway');
  say('Gateway service stopped');
}

export function status() {
  if (process.platform !== 'linux') throw Error('Gateway service requires Linux/systemd.');
  if (!existsSync('/etc/systemd/system/inx-gateway.service')) throw Error('Gateway service is not installed. Run inx-gateway start first.');
  let state: string;
  try {
    state = execFileSync('systemctl', ['is-active', 'inx-gateway'], { encoding: 'utf8' }).trim();
  } catch (e) {
    state = (e as { stdout?: string }).stdout?.trim() ?? 'unknown';
  }
  const enabled = execFileSync('systemctl', ['is-enabled', 'inx-gateway'], { encoding: 'utf8' }).trim();
  say('Gateway service is ' + state + (enabled === 'enabled' ? ' (enabled at boot)' : ' (' + enabled + ' at boot)'));
}

// Removes everything the installer set up. The 3x-ui panel is removed only when start() installed it (marker file);
// a panel that already existed on the VPS is never touched.
export function uninstall() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Uninstall requires Linux/systemd and root.');
  const link = '/usr/local/bin/inx-gateway';
  const panelManaged = existsSync(join(defaultDir, 'panel-managed'));
  let removedUnits = false;
  if (existsSync('/etc/systemd/system/inx-gateway.service')) {
    say('Stopping and removing the gateway service...');
    for (const args of [
      ['stop', 'inx-gateway'],
      ['disable', 'inx-gateway']
    ])
      run('systemctl', args, 'systemctl ' + args.join(' '));
    rmSync('/etc/systemd/system/inx-gateway.service');
    removedUnits = true;
  }
  if (panelManaged) {
    say('Removing the 3x-ui panel installed by the gateway...');
    if (existsSync('/etc/systemd/system/x-ui.service')) {
      for (const args of [
        ['stop', 'x-ui'],
        ['disable', 'x-ui']
      ])
        run('systemctl', args, 'systemctl ' + args.join(' '));
      rmSync('/etc/systemd/system/x-ui.service');
      removedUnits = true;
    }
    rmSync('/etc/systemd/system/x-ui.service.d', { recursive: true, force: true });
    for (const path of ['/usr/local/x-ui', '/etc/x-ui', '/etc/default/x-ui', '/var/log/x-ui', '/usr/bin/x-ui']) rmSync(path, { recursive: true, force: true });
  }
  if (removedUnits) run('systemctl', ['daemon-reload'], 'systemctl daemon-reload');
  say('Removing gateway files (keeping the node ID in ' + nodeIdFile + ')...');
  rmSync(defaultDir, { recursive: true, force: true });
  rmSync('/opt/inx-gateway', { recursive: true, force: true });
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(link) === '/opt/inx-gateway/current/launch') rmSync(link);
  say('Uninstalled the gateway' + (panelManaged ? ' and the 3x-ui panel it installed' : '') + '.');
}
