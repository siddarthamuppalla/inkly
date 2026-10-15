# pdf-engine image for Cloudflare Containers. Build with --platform linux/amd64. Contract: README.md.
FROM node:22.22.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ghostscript qpdf \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/ ./src/

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
