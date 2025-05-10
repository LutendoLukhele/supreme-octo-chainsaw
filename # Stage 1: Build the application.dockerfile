# Stage 1: Build the application
FROM node:18-alpine AS builder

WORKDIR /usr/src/app

# Install cpx for copying assets if it's part of the build script
# and not already a global or project dependency handled by npm install.
# If cpx is in devDependencies, `npm install` below will get it.

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy the rest of the application source code
COPY . .

# Compile TypeScript and copy assets (e.g., prompts)
# This runs the "build" script defined in your package.json
RUN npm run build

# Stage 2: Production image
FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the compiled application code from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Copy the runtime configuration files (e.g., tool-config.json)
# ToolConfigManager uses CONFIG.TOOL_CONFIG_PATH which is 'config/tool-config.json'
# This path is relative to the project root.
COPY --from=builder /usr/src/app/config ./config

# Cloud Run injects the PORT environment variable.
# Your application should listen on this port (handled by the code change above).

# Command to run the application
# Replace 'dist/index.js' with your actual main compiled entry point if different.
CMD ["node", "dist/index.js"]