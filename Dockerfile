FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV PORT=8787
EXPOSE 8787

CMD ["node", "dist/httpServer.js"]
