# syntax=docker/dockerfile:1
#
# Single-image Relayium: the Go server serves the built SPA from disk.
# Build from the repo root:  docker build -t relayium .
# Run:                       docker run -p 8080:8080 -v relayium-data:/data relayium

# --- Stage 1: build the web SPA (runs gen-legal + vite build → /web/dist) ---
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: build a static Go binary (pure-Go SQLite → CGO off) ---
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/relayium-server .
# An empty, non-root-owned data dir so the mounted volume is writable.
RUN mkdir -p /data

# --- Stage 3: minimal runtime (distroless, non-root) ---
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=server /out/relayium-server /app/relayium-server
COPY --from=web /web/dist /app/web/dist
COPY --from=server --chown=nonroot:nonroot /data /data
ENV RELAYIUM_ADDR=":8080" \
    RELAYIUM_STATIC="/app/web/dist" \
    RELAYIUM_DB="/data/relayium.db" \
    RELAYIUM_BLOB_DIR="/data/blobs"
EXPOSE 8080
# Persist the SQLite DB and stored-transfer ciphertext across restarts.
VOLUME ["/data"]
USER nonroot:nonroot
ENTRYPOINT ["/app/relayium-server"]
