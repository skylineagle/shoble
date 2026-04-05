# Stage 1: compile TypeScript
# --ignore-scripts skips isolated-vm's native build; we only need n8n-workflow for types
FROM node:20-alpine AS builder
WORKDIR /build

COPY packages/n8n-nodes/package.json ./
RUN npm install --ignore-scripts && npm install --ignore-scripts n8n-workflow

COPY packages/n8n-nodes/tsconfig.json ./
COPY packages/n8n-nodes/src ./src
RUN npm run build

# Stage 2: n8n with the custom nodes installed
FROM n8nio/n8n:latest

USER root

# Copy the compiled package; n8n-workflow is already in n8n's own node_modules
COPY --from=builder /build/dist /home/node/custom/n8n-nodes-shoble/dist
COPY --from=builder /build/package.json /home/node/custom/n8n-nodes-shoble/package.json
RUN cd /home/node/custom/n8n-nodes-shoble && npm install --ignore-scripts --omit=dev

USER node

ENV N8N_CUSTOM_EXTENSIONS=/home/node/custom
