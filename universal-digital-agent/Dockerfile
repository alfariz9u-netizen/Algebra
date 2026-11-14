# Node.js 20 (slim) + Python 3 for the AgentBazaar / Agentverse bridges
FROM node:20-slim

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Python 3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first (cached layer while package.json is unchanged)
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

# Python packages used by src/connectors/python_bridge/*
RUN pip3 install --upgrade --break-system-packages agentsbazaar uagents-core

# Application code (see .dockerignore: no data/, node_modules, tests or secrets)
COPY . .

# Render sets PORT; the combined server listens on it (health: GET /healthz)
CMD ["node", "src/combinedServer.js"]
