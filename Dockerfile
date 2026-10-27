# ----------------------
# 1️⃣ BUILD STAGE
# ----------------------
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy the full source code
COPY tsconfig.json ./
COPY scripts ./scripts
COPY images ./images
COPY src ./src

# Compile TypeScript to JavaScript and copy static assets
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# ----------------------
# 2️⃣ RUN STAGE
# ----------------------
FROM node:22-alpine

# Create non-root user/group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create the /ssl directory and ensure it's writable by appuser
RUN mkdir -p /ssl /data && chown -R appuser:appgroup /ssl /data && chmod 700 /data

# Set working directory
WORKDIR /app

# Install curl
RUN apk add --no-cache curl

# Copy compiled JS files & dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Ensure app files are owned by appuser
RUN chown -R appuser:appgroup /app

# Expose SIP (UDP/TCP) and HTTP API ports
EXPOSE 5060/udp
EXPOSE 5060/tcp
EXPOSE 5061/tcp
EXPOSE 8080/tcp

# Run as non-root
USER appuser

# Set entrypoint
CMD ["node", "dist/server.js"]

# ----------------------
# 3️⃣ HEALTH CHECK
# ----------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1    
