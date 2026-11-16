FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV TRUST_PROXY=1
ENV DB_PATH=/data/weeklies.db

EXPOSE 3000

# Hosts mount the /data disk as root at start-up, so this hands it to the unprivileged
# node user, then drops to that user to run the app.
CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node --disable-warning=ExperimentalWarning server.js"]
