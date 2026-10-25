# Nexus 2k26 Technical-Quiz Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package definition and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data directory exists
RUN mkdir -p data/recordings

# Expose server port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["node", "server.js"]
