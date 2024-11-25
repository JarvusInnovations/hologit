FROM node:20-alpine

# Install git
RUN apk add --no-cache git

# Create app directory
WORKDIR /lens

# Create repository directory
RUN mkdir /repo

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application files
COPY lib ./lib
COPY server.js ./

# Expose default port
EXPOSE 9000

# Set environment variables
ENV PORT=9000
ENV GIT_DIR=/repo

# Start the server
CMD ["node", "server.js"]
