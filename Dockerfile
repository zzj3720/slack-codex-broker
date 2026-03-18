FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gh openssh-client python3 ripgrep \
  && mkdir -p /root/.ssh \
  && chmod 700 /root/.ssh \
  && printf 'Host github.com\n  StrictHostKeyChecking accept-new\n' > /root/.ssh/config \
  && chmod 600 /root/.ssh/config \
  && git config --global credential.helper '!gh auth git-credential' \
  && git config --global url."https://github.com/".insteadOf git@github.com: \
  && git config --global --add url."https://github.com/".insteadOf ssh://git@github.com/ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.114.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_ROOT=/app/.data

CMD ["node", "dist/src/index.js"]
