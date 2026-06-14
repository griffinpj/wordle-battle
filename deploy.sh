#!/usr/bin/env bash
# Build and push the Wordle Battle image to Docker Hub.
#
# Usage:
#   ./deploy.sh                # builds + pushes :latest and :<git-sha>
#   ./deploy.sh v1.2.3         # also tags + pushes :v1.2.3
#
# Requires: docker buildx, and `docker login` already done as cougargriff.

set -euo pipefail

DOCKER_USER="${DOCKER_USER:-cougargriff}"
IMAGE_NAME="${IMAGE_NAME:-wordle-battle}"
IMAGE="${DOCKER_USER}/${IMAGE_NAME}"

# Tags
EXTRA_TAG="${1:-}"
SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

echo "==> Image: ${IMAGE}"
echo "==> Platforms: ${PLATFORMS}"
echo "==> Tags: latest, ${SHA}${EXTRA_TAG:+, ${EXTRA_TAG}}"

# Make sure we have a builder
if ! docker buildx inspect wb-builder >/dev/null 2>&1; then
  docker buildx create --name wb-builder --use >/dev/null
else
  docker buildx use wb-builder >/dev/null
fi

ARGS=(
  --platform "${PLATFORMS}"
  -t "${IMAGE}:latest"
  -t "${IMAGE}:${SHA}"
)
if [[ -n "${EXTRA_TAG}" ]]; then
  ARGS+=( -t "${IMAGE}:${EXTRA_TAG}" )
fi

docker buildx build "${ARGS[@]}" --push .

echo "==> Pushed ${IMAGE}:latest and ${IMAGE}:${SHA}${EXTRA_TAG:+ and ${IMAGE}:${EXTRA_TAG}}"
echo "==> Run with:  docker compose pull && docker compose up -d"
