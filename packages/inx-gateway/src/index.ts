#!/usr/bin/env node
import { join } from 'node:path';

import { Command } from 'commander';

import { pair, readConfig } from './config.js';
import { createGateway } from './server.js';
import { defaultDir, setup } from './setup.js';
import { version } from './version.js';

const cli = new Command('inx-gateway').description('INX Connect node gateway').version(version);
cli
  .command('setup')
  .description('Configure the gateway and print its pairing code')
  .action(async () => console.log(await setup()));

cli
  .command('pair')
  .description('Print the existing pairing secret')
  .action(() => console.log(pair(readConfig(join(defaultDir, 'config.json')))));

cli
  .command('serve')
  .description('Start the HTTPS gateway in the foreground')
  .action(async () => {
    const config = readConfig(join(process.env.CREDENTIALS_DIRECTORY ?? defaultDir, 'config.json'));
    const app = createGateway(config);
    const url = new URL(config.endpoint);
    await app.listen({ host: url.hostname.startsWith('[') ? '::' : '0.0.0.0', port: Number(url.port || 443) });
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      process.once(sig, () => {
        void app.close();
      });
  });

process.umask(0o077);
if (process.argv.length === 2) cli.help();
cli.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'Gateway failed');
  process.exitCode = 1;
});
