// The inbound start() creates on a panel it just installed, so a fresh node has one usable client right after pairing.
// VLESS + TCP + Reality with xtls-rprx-vision: no domain or certificate needed. Shape follows 3x-ui v3.11.0's own
// frontend (frontend/src/test/golden/fixtures/inbound-full/vless-tcp-reality.json).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

export const defaultRealityTarget = 'www.microsoft.com';

/** Xray-style X25519 keys: raw 32-byte keys, base64url without padding. */
export function x25519() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privateKey: privateKey.export({ format: 'jwk' }).d!, publicKey: publicKey.export({ format: 'jwk' }).x! };
}

export function defaultInbound(port: number) {
  const keys = x25519();
  const email = 'inx-' + randomBytes(3).toString('hex');
  return {
    remark: 'INX Reality',
    enable: true,
    expiryTime: 0,
    total: 0,
    listen: '',
    port,
    protocol: 'vless',
    settings: {
      clients: [{ id: randomUUID(), email, flow: 'xtls-rprx-vision', limitIp: 0, totalGB: 0, expiryTime: 0, enable: true, tgId: 0, subId: randomBytes(8).toString('hex'), comment: 'Created by INX Gateway', reset: 0 }],
      decryption: 'none',
      encryption: 'none',
      fallbacks: []
    },
    streamSettings: {
      network: 'tcp',
      tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
      security: 'reality',
      realitySettings: {
        show: false,
        xver: 0,
        target: defaultRealityTarget + ':443',
        serverNames: [defaultRealityTarget],
        privateKey: keys.privateKey,
        minClientVer: '',
        maxClientVer: '',
        maxTimediff: 0,
        shortIds: [randomBytes(8).toString('hex')],
        mldsa65Seed: '',
        settings: { publicKey: keys.publicKey, fingerprint: 'chrome', serverName: '', spiderX: '/', mldsa65Verify: '' }
      }
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic', 'fakedns'], metadataOnly: false, routeOnly: false, ipsExcluded: [], domainsExcluded: [] }
  };
}

function portFree(port: number) {
  return new Promise<boolean>(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

/** 443 when nothing listens there (Reality blends in best on 443), otherwise a free high port. */
export async function choosePort(taken: number[]) {
  if (!taken.includes(443) && (await portFree(443))) return 443;
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (!taken.includes(port) && port !== 3101 && (await portFree(port))) return port;
  }
  throw Error('No free port for the default inbound.');
}
