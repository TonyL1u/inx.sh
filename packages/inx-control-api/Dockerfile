FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100

COPY dist/index.mjs ./index.mjs

USER node

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "index.mjs"]
