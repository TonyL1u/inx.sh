# Built from this package directory after `pnpm --filter @inx.sh/console build && pnpm --filter @inx.sh/control-api build`
# (dist/ holds the bundled API and the console under dist/public).
FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 INX_DATA_DIR=/data

COPY dist/ ./

# /data must exist and belong to node so a fresh named volume inherits that ownership.
RUN mkdir /data && chown node:node /data

USER node

VOLUME /data
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "index.mjs"]
