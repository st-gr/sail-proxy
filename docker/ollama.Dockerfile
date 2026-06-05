FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

# Create app directory
WORKDIR /usr/src/app

# Copy package files and workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/ollama/package.json ./services/ollama/

# Install dependencies
# Use frozen lockfile to prevent dependency tampering
RUN pnpm install --frozen-lockfile --prod

# Copy source code
COPY services/ollama/ .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ollama -u 1001

# Change ownership of the app directory
RUN chown -R ollama:nodejs /usr/src/app
USER ollama

# Expose port
EXPOSE 11434

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:11434/health || exit 1

# Start the application
CMD ["pnpm", "start"]