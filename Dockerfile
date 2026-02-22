FROM oven/bun:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run codegen && bun run build

FROM oven/bun:latest

WORKDIR /app
COPY --from=builder /app/dist dist
COPY --from=builder /app/scripts/start.ts scripts/start.ts
COPY --from=builder /app/src/suggest.ts src/suggest.ts
COPY --from=builder /app/src/opensearch.ts src/opensearch.ts
COPY --from=builder /app/src/generated/bangs-full.js src/generated/bangs-full.js
COPY --from=builder /app/src/generated/bangs-keys.js src/generated/bangs-keys.js

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "scripts/start.ts"]
