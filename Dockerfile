# Remote deployment for the claude.ai "custom connector" (Streamable HTTP).
# The Playwright image ships Chromium plus all system libraries the WeatherWise browser tools need.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /data && chown pwuser:pwuser /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEATHERWISE_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER pwuser

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http"]
