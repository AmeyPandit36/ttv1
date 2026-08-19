FROM node:18-alpine

# Install Python3 and compile tools needed for OR-Tools compatibility
RUN apk add --no-cache python3 py3-pip make g++ gcompat

WORKDIR /app

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY apps/web/package*.json apps/web/
COPY packages/domain/package*.json packages/domain/

# Install Node dependencies
RUN npm install

# Copy source code
COPY . .

# Build workspaces (Domain, API, Web)
RUN npm run build

# Set up Python Virtualenv and solver requirements
RUN python3 -m venv .venv && .venv/bin/pip install -r scheduler/requirements.txt

EXPOSE 4000
EXPOSE 5173

ENV NODE_ENV=production

# Run database migrations and start production server
CMD ["node", "apps/api/dist/server.js"]
