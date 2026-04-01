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
ENV PATH="/home/david/.npm-local/bin:/home/david/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUN apk add --no-cache bash sudo
RUN addgroup -S david && adduser -S -G david david
RUN mkdir -p /home/david/.npm-local/bin && chown -R david:david /home/david
COPY claude-settings.json /root/.claude/settings.json
COPY claude-settings.json /home/david/.claude/settings.json
RUN chown -R david:david /home/david/.claude
ENTRYPOINT []
CMD ["node", "dist/index.js"]
