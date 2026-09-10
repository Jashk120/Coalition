# Coalition dashboard image.
#
# Build from the REPO ROOT so the local `file:../sdk` dependency resolves:
# the SDK is installed and built first, then the app installs against it
# (no published SDK needed). `docker build -f app/Dockerfile .`
#
# NEXT_PUBLIC_* values bake in at build time (Next.js inlines them), so pass
# --build-arg to target a pool/orchestrator other than the demo defaults.
# Server-only secrets (Circle, RPC, app keys) are runtime env, never baked.

FROM node:24-bookworm-slim AS build
WORKDIR /src

COPY sdk/package.json sdk/package-lock.json ./sdk/
COPY app/package.json app/package-lock.json ./app/
COPY sdk ./sdk
RUN npm --prefix sdk ci && npm --prefix sdk run build

COPY app ./app
RUN npm --prefix app ci

ARG NEXT_PUBLIC_POOL_ADDRESS=0x8b9f38c7B005Dd67203e27240F45335a9e64F692
ARG NEXT_PUBLIC_CHAIN_ID=5042002
ARG NEXT_PUBLIC_ORCHESTRATOR_URL=http://localhost:8080
ARG NEXT_PUBLIC_EXPLORER_URL=https://testnet.arcscan.app
ENV NEXT_PUBLIC_POOL_ADDRESS=$NEXT_PUBLIC_POOL_ADDRESS \
    NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_ORCHESTRATOR_URL=$NEXT_PUBLIC_ORCHESTRATOR_URL \
    NEXT_PUBLIC_EXPLORER_URL=$NEXT_PUBLIC_EXPLORER_URL
RUN npm --prefix app run build
RUN npm --prefix app prune --omit=dev

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production
WORKDIR /src/app
CMD ["npm", "start"]
