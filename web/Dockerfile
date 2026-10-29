# StreamBeam Caster — production image (no dependencies to install)
FROM node:22-alpine
WORKDIR /app
COPY index.html manifest.webmanifest sw.js server.mjs ./
COPY icons ./icons
ENV NODE_ENV=production PORT=8090 BIND=0.0.0.0
EXPOSE 8090
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server.mjs"]
