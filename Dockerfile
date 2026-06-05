FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
ENV MAB_BROWSER_HEADLESS=false
ENV MAB_DOCKER_CONTAINER=1
ENV MAB_MEET_BROWSER_CONTROL_MODE=webdriver_chromedriver
ENV MAB_MEET_UI_INTERACTION_MODE=auto
ENV MAB_MEET_XTEST_INPUT_COMMAND=/usr/local/bin/cueboard-xtest-input
ENV MEET_XTEST_INPUT_COMMAND=/usr/local/bin/cueboard-xtest-input
ENV MAB_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome
ENV CHROMEDRIVER_PATH=/usr/local/bin/chromedriver
ENV DISPLAY=:99
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gnupg \
    libx11-dev \
    libxtst6 \
    libxtst-dev \
    netcat-openbsd \
    openbox \
    pulseaudio \
    pulseaudio-utils \
    tini \
    unzip \
    xauth \
    xclip \
    xdotool \
    xvfb \
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && CHROME_VERSION="$(google-chrome --version | awk '{print $3}')" \
    && curl -fsSL -o /tmp/chromedriver-linux64.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chromedriver-linux64.zip" \
    && unzip -q /tmp/chromedriver-linux64.zip -d /tmp/chromedriver-linux64 \
    && mv /tmp/chromedriver-linux64/chromedriver-linux64/chromedriver /usr/local/bin/chromedriver \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /tmp/chromedriver-linux64 /tmp/chromedriver-linux64.zip; \
    else \
    echo "Skipping google-chrome-stable install on non-amd64 architecture"; \
    fi \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts \
  && npm rebuild better-sqlite3 esbuild

COPY apps ./apps
COPY packages ./packages
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY src ./src
COPY docs ./docs
COPY examples ./examples
COPY README.md LICENSE SECURITY.md .env.example ./

RUN mkdir -p /data /screenshots /artifacts
RUN cd packages/core/native \
  && ./build-xtest-input.sh \
  && cp cueboard-xtest-input /usr/local/bin/cueboard-xtest-input
RUN chmod +x ./scripts/docker-entrypoint.sh /usr/local/bin/cueboard-xtest-input

ENTRYPOINT ["tini", "--", "./scripts/docker-entrypoint.sh"]
CMD ["npm", "run", "dev:meeting"]
