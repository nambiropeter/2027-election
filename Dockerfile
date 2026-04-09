FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S nodejs && adduser -S nodeapp -G nodejs

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chown -R nodeapp:nodejs /app

USER nodeapp

EXPOSE 3000

CMD ["npm", "start"]
