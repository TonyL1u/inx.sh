FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/inx-control-api/package.json packages/inx-control-api/
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/inx-control-api/tsconfig*.json packages/inx-control-api/
COPY packages/inx-control-api/src/ packages/inx-control-api/src/
RUN pnpm --filter @inx/control-api build && pnpm --filter @inx/control-api --prod deploy --legacy /out

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
COPY --from=build /out/package.json ./
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
