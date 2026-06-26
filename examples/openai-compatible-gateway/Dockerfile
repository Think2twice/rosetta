FROM node:22-bookworm AS build

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && mkdir -p /tmp/rosetta-package \
  && npm pack --pack-destination /tmp/rosetta-package

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    ca-certificates \
    fonts-noto-cjk \
    fonts-liberation \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /tmp/rosetta-package/*.tgz /tmp/rosetta.tgz
RUN npm init -y \
  && npm install /tmp/rosetta.tgz chrome-remote-interface \
  && rm -f /tmp/rosetta.tgz

COPY examples/openai-compatible-gateway/server.mjs /app/server.mjs
COPY examples/openai-compatible-gateway/start.sh /usr/local/bin/rosetta-openai-gateway
RUN chmod +x /usr/local/bin/rosetta-openai-gateway

ENV DISPLAY=:99
EXPOSE 3000 6080 9222

ENTRYPOINT ["dumb-init", "--"]
CMD ["rosetta-openai-gateway"]
