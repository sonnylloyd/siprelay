# ----------------------
# 1️⃣ BUILD STAGE
# ----------------------
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json ./
RUN npm install

# Copy the full source code
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to JavaScript
RUN npx tsc

# ----------------------
# 2️⃣ RUN STAGE
# ----------------------
FROM node:20-alpine

# Create the /ssl directory and ensure it's writable
RUN mkdir -p /ssl && chmod -R 777 /ssl

# Set working directory
WORKDIR /app

# Install Docker CLI (needed to interact with Docker API)
RUN apk add --no-cache docker-cli

# Copy compiled JS files & dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Expose SIP (UDP/TCP) and HTTP API ports
EXPOSE 5060/udp
EXPOSE 5061/tcp
EXPOSE 8080/tcp

# Set a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 🛠️ Fix: Temporarily use root to set permissions
USER root
RUN chown appuser /var/run/docker.sock || true

USER appuser

# Set entrypoint
CMD ["node", "dist/server.js"]

# ----------------------
# 3️⃣ HEALTH CHECK
# ----------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1    