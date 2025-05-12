FROM node:18-alpine

WORKDIR /app

EXPOSE 8080

# Copy package.json and package-lock.json
COPY package*.json ./

# Install all dependencies, including devDependencies (ts-node, typescript, etc.)
RUN npm install

# Copy the rest of the app
COPY . .

# Start the server using ts-node
CMD ["npx", "ts-node", "src/index.ts"]