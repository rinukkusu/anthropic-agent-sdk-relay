FROM oven/bun:1-debian

# The Agent SDK ships the Claude Code binary through npm optional dependencies,
# so this install must not skip them.
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# A real HOME, so a mounted ~/.claude resolves and the CLI has somewhere to write.
ENV HOME=/home/bun
RUN mkdir -p /home/bun/.claude /workspace && chown -R bun:bun /home/bun /workspace /app
USER bun

ENV PORT=8787 \
    RELAY_HOST=0.0.0.0 \
    RELAY_CWD=/workspace
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
