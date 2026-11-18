// A node's domain is 3x-ui's own: the panel certificate set through x-ui's "SSL Certificate Management"
// ("Get SSL (Domain)" + "Set Cert paths for the panel"). The Gateway keeps no domain of its own, so a domain set
// in x-ui and one bound from the controller are the same thing.
//
// Binding from the controller needs root (acme.sh, port 80, x-ui settings). The unprivileged service only writes a
// one-line request into its runtime directory; inx-gateway-domain.path starts the root oneshot that runs
// scripts/xui-domain.sh, which reports progress in the status file next to it.
import { readFileSync, writeFileSync } from 'node:fs';

import type { GatewayDomain } from './protocol.js';

const runtimeDir = process.env.INX_RUNTIME_DIR ?? '/run/inx-gateway';
export const domainRequestFile = runtimeDir + '/domain-request';
export const domainStatusFile = runtimeDir + '/domain-status.json';

// x-ui.sh is_domain, plus the DNS length limit.
export const isDomain = (d: string) => d.length <= 253 && /^([A-Za-z0-9](-*[A-Za-z0-9])*\.)+(xn--[a-z0-9]{2,}|[A-Za-z]{2,})$/.test(d);

/** The domain in a panel cert path: x-ui installs to /root/cert/<domain>/, acme.sh keeps ~/.acme.sh/<domain>[_ecc]/. */
export function certDomain(path: string) {
  const m = /^\/root\/cert\/([^/]+)\/[^/]+$/.exec(path) ?? /\/\.acme\.sh\/([^/]+?)(?:_ecc)?\/[^/]+$/.exec(path);
  const domain = m?.[1]?.toLowerCase();
  return domain && isDomain(domain) ? domain : undefined;
}

export function requestDomain(domain: string) {
  writeFileSync(domainRequestFile, 'set ' + domain.toLowerCase() + '\n', { mode: 0o644 });
}
export function requestDomainRemoval() {
  writeFileSync(domainRequestFile, 'remove\n', { mode: 0o644 });
}

/** Progress of the last request, written by xui-domain.sh. Absent before any request. */
export function domainStatus(): Pick<GatewayDomain, 'state' | 'requested' | 'error' | 'log' | 'updatedAt'> {
  try {
    const s = JSON.parse(readFileSync(domainStatusFile, 'utf8')) as Record<string, unknown>;
    let state = ['pending', 'issued', 'removed', 'failed'].includes(s.state as string) ? (s.state as GatewayDomain['state']) : 'idle';
    let error = typeof s.error === 'string' && s.error ? s.error : null;
    // acme.sh issuance takes seconds to a few minutes; a helper that died mid-run must not block new requests forever.
    if (state === 'pending' && typeof s.updatedAt === 'number' && Date.now() - s.updatedAt * 1000 > 15 * 60_000) {
      state = 'failed';
      error = 'DOMAIN_TIMEOUT';
    }
    return {
      state,
      requested: typeof s.domain === 'string' && s.domain ? s.domain : null,
      error,
      log: typeof s.log === 'string' ? s.log.slice(-4000) : null,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt * 1000 : null
    };
  } catch {
    return { state: 'idle', requested: null, error: null, log: null, updatedAt: null };
  }
}
