#!/bin/sh
set -eu

DOCKER_BIN="${DOCKER_BIN:-docker}"
IMAGE_TAG="${MAB_DOCKER_IMAGE:-meeting-avatar-bot:local}"
SHM_SIZE="${MAB_DOCKER_SHM_SIZE:-1g}"
PLATFORM="${MAB_DOCKER_PLATFORM:-linux/amd64}"

echo "[docker-smoke] building ${IMAGE_TAG}"
"${DOCKER_BIN}" build --platform "${PLATFORM}" -t "${IMAGE_TAG}" .

echo "[docker-smoke] verifying Chrome/ChromeDriver/XTEST baseline"
"${DOCKER_BIN}" run --rm --platform "${PLATFORM}" --shm-size="${SHM_SIZE}" "${IMAGE_TAG}" sh -lc '
  set -eu
  google-chrome --version
  chromedriver --version
  /usr/local/bin/cueboard-xtest-input probe --json
  node --input-type=module -e "import { chromium } from \"playwright\"; const browser = await chromium.launch({ executablePath: \"/usr/bin/google-chrome\", headless: false, args: [\"--no-sandbox\", \"--disable-dev-shm-usage\"] }); console.log(await browser.version()); await browser.close();"
'

echo "[docker-smoke] verifying screen-share bridge"
"${DOCKER_BIN}" run --rm --platform "${PLATFORM}" --shm-size="${SHM_SIZE}" "${IMAGE_TAG}" npm run smoke:screen-share

echo "[docker-smoke] verifying hiyori live2d camera path"
"${DOCKER_BIN}" run --rm --platform "${PLATFORM}" --shm-size="${SHM_SIZE}" "${IMAGE_TAG}" npm run smoke:hiyori-live2d
