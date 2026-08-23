FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY db ./db

RUN npx tsc -p tsconfig.json

EXPOSE 3000
CMD ["node", "dist/server.js"]
