FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
EXPOSE 3200
ENV PORT=3200
CMD ["node", "dist/index.js"]
