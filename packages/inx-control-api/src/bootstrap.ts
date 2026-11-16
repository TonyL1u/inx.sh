import type { FastifyInstance } from 'fastify';

const repo = 'TonyL1u/inx.sh';
const number = '(?:0|[1-9]\\d*)';
const core = `${number}\\.${number}\\.${number}`;
const stable = new RegExp(`^${core}$`);
const pinned = new RegExp(`^${core}(?:-beta\\.${number})?$`);
const cacheMs = 60_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string }[];
}

// Other packages may publish releases in the same repository.
async function latestGateway(request: FetchLike) {
  let newest: { version: string; published: number } | undefined;
  const signal = AbortSignal.timeout(8000);
  for (let page = 1; ; page++) {
    const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'inx-control-api' }, signal });
    if (!response.ok) throw Error('GitHub releases unavailable');
    const releases: Release[] = await response.json();
    for (const release of releases) {
      const candidate = release.tag_name;
      if (release.draft || release.prerelease || !release.published_at || !stable.test(candidate) || !release.assets.some(a => a.name === 'bootstrap')) continue;
      const published = Date.parse(release.published_at);
      if (Number.isFinite(published) && (!newest || published > newest.published)) newest = { version: candidate, published };
    }
    if (!response.headers.get('link')?.includes('rel="next"')) return newest?.version;
  }
}

export function registerBootstrap(app: FastifyInstance, request: FetchLike = fetch) {
  const asset = (v: string) => `https://github.com/${repo}/releases/download/${v}/bootstrap`;
  let cache: { version: string | undefined; until: number } | undefined;
  let pending: Promise<string | undefined> | undefined;

  app.get('/bootstrap', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (!cache || Date.now() >= cache.until) {
        pending ??= latestGateway(request)
          .then(v => {
            cache = { version: v, until: Date.now() + cacheMs };
            return v;
          })
          .finally(() => {
            pending = undefined;
          });
        await pending;
      }
      if (!cache?.version) return reply.code(404).send({ error: 'NO_GATEWAY_RELEASE' });
      return reply.redirect(asset(cache.version), 302);
    } catch {
      return reply.code(503).send({ error: 'RELEASE_LOOKUP_UNAVAILABLE' });
    }
  });

  app.get<{ Params: { release: string } }>('/bootstrap/:release', async (req, reply) => {
    const v = req.params.release;
    if (!pinned.test(v)) return reply.code(404).send({ error: 'INVALID_GATEWAY_RELEASE' });
    return reply.redirect(asset(v), 302);
  });
}
