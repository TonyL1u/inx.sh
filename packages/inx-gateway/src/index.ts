#!/usr/bin/env node
import { join } from 'node:path';

import { Command } from 'commander';

import { pair, readConfig } from './config.js';
import { createGateway } from './server.js';
import { defaultDir, start, status, stop, uninstall } from './setup.js';
import { version } from './version.js';

// The systemd unit runs the gateway with no arguments.
async function serve() {
  const config = readConfig(join(process.env.CREDENTIALS_DIRECTORY ?? defaultDir, 'config.json'));
  const app = createGateway(config);
  const url = new URL(config.endpoint);
  await app.listen({ host: url.hostname.startsWith('[') ? '::' : '0.0.0.0', port: Number(url.port || 443) });
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      void app.close();
    });
}

const cli = new Command('inx-gateway').description('INX Connect node gateway').version(version);

cli
  .command('start')
  .description('Configure the gateway, start its service and print its pairing code')
  .action(async () => console.log(await start()));
cli
  .command('stop')
  .description('Stop the gateway service')
  .action(() => stop());
cli
  .command('status')
  .description('Show whether the gateway service is running')
  .action(() => status());
cli
  .command('uninstall')
  .description('Stop and remove the gateway, its service and all installed files')
  .action(() => uninstall());
cli
  .command('pair')
  .description('Print the existing pairing secret')
  .action(() => console.log(pair(readConfig(join(defaultDir, 'config.json')))));

process.umask(0o077);
const fail = (e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Gateway failed');
  process.exitCode = 1;
};

if (process.argv.length === 2) serve().catch(fail);
else cli.parseAsync().catch(fail);
