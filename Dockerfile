FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder

ARG ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=false
ENV ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS=$ALLOW_UNSAFE_CUSTOM_SUGGEST_URLS

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run codegen --from-merged && bun run build

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

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
