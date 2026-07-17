FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder

ARG ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=false
ENV ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=$ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run codegen --from-merged && bun run build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

ARG ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=false
ENV ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=$ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS

WORKDIR /app
COPY --from=builder /app/dist dist
COPY --from=builder /app/scripts/start.ts scripts/start.ts
COPY --from=builder /app/src/suggest.ts src/suggest.ts
COPY --from=builder /app/src/suggest-bang.ts src/suggest-bang.ts
COPY --from=builder /app/src/opensearch.ts src/opensearch.ts
COPY --from=builder /app/src/server/handlers.ts src/server/handlers.ts
COPY --from=builder /app/src/server/headers.ts src/server/headers.ts
COPY --from=builder /app/src/shared/chars.ts src/shared/chars.ts
COPY --from=builder /app/src/shared/constants.ts src/shared/constants.ts
COPY --from=builder /app/src/shared/frecency-serial.ts src/shared/frecency-serial.ts
COPY --from=builder /app/src/shared/raw-query.ts src/shared/raw-query.ts
COPY --from=builder /app/src/shared/raw-url.ts src/shared/raw-url.ts
COPY --from=builder /app/src/shared/suggest-cookie.ts src/shared/suggest-cookie.ts
COPY --from=builder /app/src/shared/template.ts src/shared/template.ts
COPY --from=builder /app/src/shared/trigger-prefix.ts src/shared/trigger-prefix.ts
COPY --from=builder /app/src/generated/bangs-trie.js src/generated/bangs-trie.js

USER bun

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=5 CMD bun -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "scripts/start.ts"]
