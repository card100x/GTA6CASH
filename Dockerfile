# KMC relay + site, for Fly.io. Persistent state and keys live on the /app/relay/data volume.
FROM node:22-slim
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY relay/ ./
COPY web/ /app/web/
ENV NODE_ENV=production \
    WEB_DIR=/app/web \
    DATA_DIR=data \
    STATE_FILE=data/state-mainnet.json \
    ESCROW_KEY=data/keys/escrow-mainnet.json \
    WALLETS_KEY_FILE=data/keys/wallets-mainnet.key \
    XBOX_TOKEN_FILE=data/keys/xbox-mainnet.json \
    PORT=8080
EXPOSE 8080
# Refuse to start until the real keys are on the volume: otherwise loadKeypair
# would quietly generate a NEW escrow and the site would point at an empty wallet.
CMD ["sh", "-c", "test -f data/keys/escrow-mainnet.json && test -f data/keys/wallets-mainnet.key || { echo 'waiting for keys on the volume (data/keys)'; sleep infinity; }; exec npx tsx src/index.ts"]
