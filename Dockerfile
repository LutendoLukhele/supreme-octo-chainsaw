# Use a lightweight and official Node.js runtime
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install only production dependencies to keep the image small
# Note: Since your build tool 'cpx' is a dependency, we install all first, then prune.
RUN npm install

# Copy the rest of your application source code
COPY . .

# Run your build script (which compiles TS to JS and copies assets)
RUN npm run build

# Prune development dependencies after the build is complete
RUN npm prune --production

# Expose the port your application will run on (e.g., 8080 for Cloud Run)
EXPOSE 8080

# Set the command to start your application using the compiled JavaScript
CMD [ "npm", "start" ]