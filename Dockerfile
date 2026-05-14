FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
ENV MAB_BROWSER_HEADLESS=true
ENV MAB_CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    ffmpeg \
    pulseaudio \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY apps ./apps
COPY packages ./packages
COPY src ./src
COPY docs ./docs
COPY examples ./examples
COPY README.md LICENSE SECURITY.md .env.example ./

RUN mkdir -p /data /screenshots /artifacts

ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "dev:meeting"]
