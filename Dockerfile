FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
EXPOSE 3200
ENV PORT=3200
ENV SHELL=/bin/bash
ENV DEFAULT_MODEL=claude-sonnet-4-6
ENV FALLBACK_MODEL=claude-haiku-4-5
RUN apk add --no-cache bash
COPY claude-settings.json /root/.claude/settings.json
CMD ["node", "dist/index.js"]
