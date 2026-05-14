#!/bin/sh
set -eu

DOCKER_BIN="${DOCKER_BIN:-docker}"
IMAGE_TAG="${MAB_DOCKER_IMAGE:-meeting-avatar-bot:local}"
SHM_SIZE="${MAB_DOCKER_SHM_SIZE:-1g}"

echo "[docker-smoke] building ${IMAGE_TAG}"
"${DOCKER_BIN}" build -t "${IMAGE_TAG}" .

echo "[docker-smoke] verifying screen-share bridge"
"${DOCKER_BIN}" run --rm --shm-size="${SHM_SIZE}" "${IMAGE_TAG}" npm run smoke:screen-share

echo "[docker-smoke] verifying hiyori live2d camera path"
"${DOCKER_BIN}" run --rm --shm-size="${SHM_SIZE}" "${IMAGE_TAG}" npm run smoke:hiyori-live2d
