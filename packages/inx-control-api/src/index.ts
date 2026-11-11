import Fastify from 'fastify';

import { registerBootstrap } from './bootstrap.js';

const app = Fastify();
registerBootstrap(app);
app.get('/health', () => ({ service: 'inx-control', apiVersion: 1 }));

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
