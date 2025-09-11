FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# install deps
COPY package*.json ./
RUN npm install --omit=dev

# app code
COPY server.js ./

# WICHTIG: keinen festen PORT setzen; Render setzt $PORT selbst
# EXPOSE ist optional, schadet aber nicht:
EXPOSE 3000

CMD ["node","server.js"]
