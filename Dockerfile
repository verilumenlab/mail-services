# Long-running server image: the Next.js app plus its in-process background worker
# (campaign queue, e-signature reminders, expiry, notification retries and finalization).
# Build:  docker build -t sorts .
# Run:    docker run -p 3000:3000 --env-file .env.production -v sorts-data:/app/data sorts

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# LibreOffice converts uploaded DOCX files to PDF; the fonts keep converted layouts close to Word's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libreoffice-writer-nogui \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LIBREOFFICE_PATH=/usr/bin/soffice \
    ESIGN_STORAGE_DIR=/app/data/esign \
    HOME=/tmp
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /app/data/esign && chown -R node:node /app/data
USER node
# Encrypted originals, signed PDFs and certificates live here; it must survive redeploys.
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx next start"]
