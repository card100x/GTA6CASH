FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY worker.js ./
ENV STATE_FILE=/data/state.json
CMD ["node", "worker.js"]
