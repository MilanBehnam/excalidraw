FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.ts ./
USER node
EXPOSE 3002
CMD ["node", "server.ts"]
