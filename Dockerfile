# Three stages: the first typechecks and bundles the bot, the second builds
# replay-parser's wows-render for /render, the last carries only the bundle,
# the production dependencies and the renderer.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# The renderer, from source at a fixed commit. Takes a few minutes and about
# 2 GB of memory the first time; Docker caches it after that. To update,
# change REPLAY_PARSER_REF to a newer commit of replay-parser's main.
FROM rust:1-bookworm AS render
ARG REPLAY_PARSER_REF=4fc2a94d65ffd8911ebcd364d012d8c1b56ec19a
# nasm: OpenH264's x86 SIMD kernels (without it encoding is about 2x slower).
RUN apt-get update && apt-get install -y --no-install-recommends nasm && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git fetch -q --depth 1 https://github.com/LeCyanide/replay-parser.git "$REPLAY_PARSER_REF"     && git checkout -q FETCH_HEAD
RUN cargo build --release --locked -p wows-replay-render --bin wows-render     && strip target/release/wows-render

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production     DB_PATH=/data/bot.db     HTTP_HOST=0.0.0.0     HTTP_PORT=8787     WOWS_RENDER_BIN=/usr/local/bin/wows-render
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=render /src/target/release/wows-render /usr/local/bin/wows-render
COPY --from=render /src/LICENSE /usr/share/doc/wows-render/LICENSE
COPY --from=render /src/render/assets/Inter-OFL.txt /usr/share/doc/wows-render/Inter-OFL.txt
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/bot.js"]
