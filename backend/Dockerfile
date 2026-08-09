# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies (including dev deps for the TypeScript build)
COPY package.json package-lock.json* ./
RUN npm install

# Compile TypeScript -> dist
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for a lean runtime node_modules
RUN npm prune --omit=dev

# ---- Run stage ----
FROM node:20-alpine AS run
ENV NODE_ENV=production
WORKDIR /app

# Copy runtime artifacts only
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# docs/openapi.yaml is mounted/served relative to the repo; copy if present in build context.
# The compose file mounts the repo, but for standalone images the API serves a static note if missing.

EXPOSE 4000

# Default entrypoint = API. Override in compose for worker / listener:
#   command: node dist/workers/index.js
#   command: node dist/blockchain/listener.js
CMD ["node", "dist/index.js"]
