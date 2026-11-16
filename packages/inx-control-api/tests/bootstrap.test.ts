import assert from 'node:assert/strict';

import Fastify from 'fastify';
import { test, type TestContext } from 'vitest';

import { registerBootstrap } from '../src/bootstrap.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Release {
  tag_name: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

const download = 'https://github.com/TonyL1u/inx.sh/releases/download/';
const release = (tag: string, published: string, extra: Partial<Release> = {}): Release => ({ tag_name: tag, published_at: published, draft: false, prerelease: false, assets: [{ name: 'bootstrap' }], ...extra });
function server(t: TestContext, request: FetchLike) {
  const app = Fastify();
  registerBootstrap(app, request);
  t.onTestFinished(() => app.close());
  return app;
}

test('a pinned URL selects exactly one installer without consulting latest', async t => {
  const app = server(t, () => assert.fail('unexpected catalog lookup'));
  for (const v of ['0.1.0', '0.1.0-beta.0', '12.30.401-beta.12']) {
    const response = await app.inject('/bootstrap/' + v);
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, download + v + '/bootstrap');
  }
  for (const label of ['latest', 'release-0.1.0', '0.1.0-beta', '0.1.0-beta.01', 'beta-0.1.0', '01.2.3']) {
    assert.equal((await app.inject('/bootstrap/' + label)).statusCode, 404);
  }
});

test('latest uses the newest published stable gateway across pages and shares the lookup', async t => {
  const seen: (string | null)[] = [];
  const app = server(t, async url => {
    const page = new URL(url).searchParams.get('page');
    seen.push(page);
    if (page === '1')
      return Response.json([release('1.0.0', '2026-08-01', { assets: [] }), release('0.1.0-beta.0', '2026-08-01'), release('3.0.0', '2026-07-01', { prerelease: true }), release('2.0.0', '2026-06-01', { draft: true }), release('0.1.0', '2026-01-01')], {
        headers: { link: '<https://api.github.com/>; rel="next"' }
      });
    return Response.json([release('0.2.0', '2026-02-01')]);
  });
  const responses = await Promise.all([app.inject('/bootstrap'), app.inject('/bootstrap')]);
  responses.push(await app.inject('/bootstrap'));
  for (const r of responses) {
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, download + '0.2.0/bootstrap');
  }
  assert.deepEqual(seen, ['1', '2']);
});

test('lookup failures are retried; an empty catalog does not return an installer', async t => {
  let calls = 0;
  const app = server(t, async () => (++calls === 1 ? new Response(null, { status: 403 }) : Response.json([])));
  const failed = await app.inject('/bootstrap');
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers.location, undefined);
  const empty = await app.inject('/bootstrap');
  assert.equal(empty.statusCode, 404);
  assert.equal(empty.headers.location, undefined);
});
