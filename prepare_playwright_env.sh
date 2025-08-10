#!/bin/sh
set -e

# Install Playwright Chromium + system deps (Leapcell recommends this)
npx -y playwright@latest install --with-deps chromium

# Install node modules
npm install
