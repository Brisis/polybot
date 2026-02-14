# Use Node.js 22 Alpine for smaller image size
FROM node:22-alpine

# Install dumb-init to handle signals properly
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy source code
COPY . .

# Create logs directory
RUN mkdir -p logs && \
    chown -R node:node /app

# Run as non-root user for security
USER node

# Healthcheck to ensure bot is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "console.log('Bot healthcheck OK')" || exit 1

# Use dumb-init to handle signals properly (graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

# Start the bot
CMD ["npm", "start"]