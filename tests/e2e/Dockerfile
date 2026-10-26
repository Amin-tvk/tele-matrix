# Test runner: Node + Chromium for Playwright, ffmpeg to make sample media
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
