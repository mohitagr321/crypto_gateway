# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
# VITE_API_BASE_URL is baked at build time; override with --build-arg if needed.
ARG VITE_API_BASE_URL=http://localhost:4000/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ---- Serve stage ----
FROM nginx:1.27-alpine AS serve
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
