FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY pdf_extract.py requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --no-cache-dir -r requirements.txt
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["npm","start"]
