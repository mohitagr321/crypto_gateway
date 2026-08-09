# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# VITE_* vars are baked at build time. Override with --build-arg if needed.
ARG VITE_API_BASE_URL=http://localhost:4000/api/v1
ARG VITE_BSCSCAN_URL=https://bscscan.com
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_BSCSCAN_URL=$VITE_BSCSCAN_URL

RUN npm run build

# ---- Serve stage ----
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
