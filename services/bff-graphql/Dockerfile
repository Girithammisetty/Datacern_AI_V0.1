# bff-graphql — Node 20 + pnpm. Runs the TypeScript directly via tsx (no build
# artifact drift). Stateless: holds no credentials, no DB, no broker.
FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable
COPY services/bff-graphql/package.json services/bff-graphql/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY services/bff-graphql/package.json services/bff-graphql/tsconfig.json ./
COPY services/bff-graphql/src ./src

# Drop privileges.
# 1000 numerically, not the `node` NAME the official Node image defines — the
# kubelet cannot resolve a username and refuses the pod under runAsNonRoot:
#   container has runAsNonRoot and image has non-numeric user (node),
#   cannot verify user is non-root
# 1000 is the uid `node` already maps to in node:*-slim/alpine images.
USER 1000
EXPOSE 4000

# Liveness probe target: GET /healthz (no downstream deps).
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
