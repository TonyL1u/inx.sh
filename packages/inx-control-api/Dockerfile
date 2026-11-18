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

# HTTPS once `inx-connect domain` has mounted a certificate (the certificate names the domain, not 127.0.0.1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "-e", "const fs=require('fs');const tls=fs.existsSync(process.env.INX_TLS_CERT||'/cert/fullchain.pem')&&fs.existsSync(process.env.INX_TLS_KEY||'/cert/privkey.pem');require(tls?'https':'http').get({host:'127.0.0.1',port:process.env.PORT,path:'/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "index.mjs"]
