# syntax=docker/dockerfile:1
# node:22-alpine manifest digest looked up from the Docker Hub registry
# on 23 Nov 2026 (docker-content-digest for the 22-alpine index).
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
ENV NODE_ENV=production \
    MERDIENZ_MODE=selfhosted \
    PORT=4840 \
    NODE_OPTIONS=--max-old-space-size=256
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations
COPY --from=web /web/dist ./web/dist
USER node
EXPOSE 4840
CMD ["node", "src/index.js"]
