FROM node:22-bookworm-slim

# LibreOffice turns Word / PowerPoint / Excel uploads into page-by-page views.
# The fonts cover Latin and Arabic so converted documents look right.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui \
      fonts-dejavu fonts-liberation fonts-noto-core fonts-crosextra-carlito fonts-crosextra-caladea \
      python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && apt-get purge -y make g++ && apt-get autoremove -y
COPY . .

ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
