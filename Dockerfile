FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder

ARG ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=false
ENV ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=$ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run codegen --from-merged && bun run build

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

ARG ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=false
ENV ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=$ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS

WORKDIR /app
COPY --from=builder /app/dist dist
COPY --from=builder /app/dist-server dist-server

USER bun

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=5 CMD bun -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "dist-server/server.js"]
