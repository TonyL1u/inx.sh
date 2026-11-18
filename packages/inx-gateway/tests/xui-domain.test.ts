import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, type TestContext } from 'vitest';

const script = fileURLToPath(new URL('../scripts/xui-domain.sh', import.meta.url));

// Runs the helper with stand-ins for acme.sh, the x-ui binary, systemctl, ss and getent that record their arguments.
function sandbox(t: TestContext, { port80Busy = false, issueFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inx-xui-domain-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'acme'));
  const calls = join(dir, 'calls');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${calls}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('ss', port80Busy ? 'echo "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*"' : '');
  stub('getent', 'echo "203.0.113.5     STREAM $2"');
  stub('ip', 'echo "    inet 203.0.113.5/24 scope global eth0"');
  stub('socat', '');
  stub('systemctl', '');
  stub('x-ui', '');
  stub(
    'acme.sh',
    `case "$1" in
  --issue) ${issueFails ? 'exit 1' : 'exit 0'} ;;
  --installcert) while [[ $# -gt 0 ]]; do case "$1" in --key-file|--fullchain-file) echo pem > "$2"; shift ;; esac; shift; done ;;
esac`
  );
  const run = (request: string) => {
    writeFileSync(join(dir, 'request'), request);
    const result = spawnSync('bash', [script, join(dir, 'request'), join(dir, 'status.json')], {
      env: { PATH: bin + ':/usr/bin:/bin', HOME: dir, XUI_BIN: join(bin, 'x-ui'), ACME_SH: join(dir, 'acme', 'acme.sh'), XUI_CERT_DIR: join(dir, 'cert') },
      encoding: 'utf8'
    });
    return { code: result.status, status: JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')), calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
  };
  // acme.sh "installed" at ACME_SH.
  writeFileSync(join(dir, 'acme', 'acme.sh'), `#!/bin/bash\nexec ${join(bin, 'acme.sh')} "$@"\n`);
  chmodSync(join(dir, 'acme', 'acme.sh'), 0o755);
  return { dir, run };
}

test('binding runs x-ui’s SSL steps and sets the certificate for the panel', t => {
  const { dir, run } = sandbox(t);
  const { code, status, calls } = run('set HK.Example.com\n');
  assert.equal(code, 0, JSON.stringify(status));
  assert.equal(status.state, 'issued');
  assert.equal(status.domain, 'hk.example.com');
  const cert = join(dir, 'cert', 'hk.example.com');
  assert.deepEqual(
    calls.filter(c => /^(acme\.sh|x-ui|systemctl) /.test(c)),
    [
      'acme.sh --set-default-ca --server letsencrypt --force',
      'acme.sh --issue -d hk.example.com --standalone --httpport 80 --force',
      `acme.sh --installcert --force -d hk.example.com --key-file ${cert}/privkey.pem --fullchain-file ${cert}/fullchain.pem --reloadcmd x-ui restart`,
      'acme.sh --upgrade --auto-upgrade',
      `x-ui cert -webCert ${cert}/fullchain.pem -webCertKey ${cert}/privkey.pem`,
      'systemctl restart x-ui'
    ]
  );
  assert.match(status.log, /Done: the panel certificate is now hk\.example\.com/);
});

test('failures are reported with a code and nothing is set for the panel', t => {
  const busy = sandbox(t, { port80Busy: true }).run('set hk.example.com\n');
  assert.equal(busy.status.state, 'failed');
  assert.equal(busy.status.error, 'DOMAIN_PORT_80_BUSY');
  assert.ok(!busy.calls.some(c => c.startsWith('acme.sh') || c.startsWith('x-ui')));

  const acme = sandbox(t, { issueFails: true }).run('set hk.example.com\n');
  assert.equal(acme.status.error, 'DOMAIN_ACME_FAILED');
  assert.ok(!acme.calls.some(c => c.startsWith('x-ui')));

  const invalid = sandbox(t).run('set $(reboot).com\n');
  assert.equal(invalid.status.error, 'DOMAIN_INVALID');
  assert.deepEqual(invalid.calls, []);
});

test('removal resets the panel certificate like x-ui', t => {
  const { status, calls } = sandbox(t).run('remove\n');
  assert.equal(status.state, 'removed');
  assert.deepEqual(calls, ['x-ui cert -reset', 'systemctl restart x-ui']);
});
