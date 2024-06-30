# Use an official Node.js runtime as the base image
FROM node:18.16.1-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose the port the app runs on
EXPOSE 3300

# Define the command to run the app
CMD ["node", "api_server.js"]