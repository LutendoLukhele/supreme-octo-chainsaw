# --- Build Stage ---
# This stage builds the TypeScript into JavaScript
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- Production Stage ---
# This stage creates the final, clean image for deployment
FROM node:18-alpine
WORKDIR /app

# Copy necessary files from the build stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 8080

# This command will run 'node dist/index.js' as defined in your package.json
CMD ["npm", "start"]