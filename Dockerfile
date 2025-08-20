# Use the official Playwright image with all browser deps baked in.
FROM mcr.microsoft.com/playwright:v1.45.2-jammy

WORKDIR /app

# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Create output folders (mounted as volumes in Coolify)
RUN mkdir -p /app/reports /app/error_shots

# Default env for server runtime (you can override in Coolify)
ENV HEADLESS=true \
    SLOWMO_MS=0 \
    LOAD_STATE=networkidle

# Playwright browsers are preinstalled in this base image,
# but keep this here if you ever switch to a non-Playwright base:
# RUN npx playwright install --with-deps chromium

# Run your script
CMD ["node", "playwright-runner.cjs"]
