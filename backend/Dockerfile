FROM node:22-alpine

# openssl  — Prisma's query engine needs it on Alpine.
# git      — the workspace is a real repository; the developer agent's changes are committed to it.
# python3, make, g++ — some MCP servers are npx packages with native build steps.
RUN apk add --no-cache openssl git python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install

# The vendors' own CLIs, for subscription entitlements. Installed best-effort: if the registry is
# unreachable at build time the image still works on API keys, and the Settings page reports each
# CLI as missing rather than the whole build failing.
ARG INSTALL_SUBSCRIPTION_CLIS=true
RUN if [ "$INSTALL_SUBSCRIPTION_CLIS" = "true" ]; then \
      npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli || \
      echo "warning: one or more subscription CLIs could not be installed"; \
    fi

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV WORKSPACE_ROOT=/workspace
RUN mkdir -p /workspace

EXPOSE 3001

# The schema is applied on every boot: `db push` is idempotent, and it means a fresh volume comes up
# working without anyone remembering to run a migration step.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm run seed && npm start"]
