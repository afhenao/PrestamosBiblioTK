# Imagen de PrestamosBiblioTK: solo dependencias de producción y el código (sin .env: la configuración
# llega por variables de entorno desde Docker Compose o Kubernetes)
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Sin root dentro del contenedor
USER node

EXPOSE 3005
CMD ["node", "src/app.js"]
