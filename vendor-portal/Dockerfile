FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server
COPY web ./web
EXPOSE 4000
# Security review finding M8: no USER directive otherwise runs this as root. Port 4000 is
# non-privileged, so node:20-alpine's built-in non-root "node" user works with no other changes.
USER node
CMD ["node", "server/index.js"]
