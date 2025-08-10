#!/bin/sh
set -e

# Install Chromium + OS deps during the BUILD step (not at runtime)
npx -y playwright install --with-deps chromium

# Install Node deps (use install here; if you prefer CI-style, switch to npm ci)
npm install
