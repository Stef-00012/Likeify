FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache \
    build-base \
    python3 \
    sqlite-dev

COPY package.json package-lock.json /app/
RUN npm i

COPY . .

ENTRYPOINT ["npm", "run", "build"]