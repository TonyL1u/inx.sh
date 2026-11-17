import { buildApp } from './app.js';
import { createSetupCode } from './auth.js';
import { dbPath, loadConfig } from './config.js';
import { openDb } from './db.js';

const [command = 'serve', ...args] = process.argv.slice(2);

try {
  const config = loadConfig();
  const db = openDb(dbPath(config), config.secretKey);

  if (command === 'setup-code') {
    // Run inside the container: docker compose exec inx-connect node index.mjs setup-code [--reset]
    console.log(createSetupCode(db, args.includes('--reset')));
    db.close();
  } else if (command === 'serve') {
    const app = await buildApp(config, db);
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        void app.close().then(() => db.close());
      });
  } else {
    throw Error(`Unknown command: ${command}. Commands: serve, setup-code [--reset]`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
