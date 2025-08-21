# Use the Playwright image that matches the library version
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/reports /app/error_shots

# Keep headless by default in containers; override in Coolify if needed
ENV HEADLESS=true \
    SLOWMO_MS=0 \
    LOAD_STATE=networkidle

CMD ["tail","-f","/dev/null"]
