# Use the Playwright image that matches your library version
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

# App home
WORKDIR /app

# Install prod deps (make sure playwright 1.54.2 is in "dependencies")
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Ensure report/error dirs exist and are writable by runtime user
# (the base image runs as pwuser)
RUN mkdir -p /app/reports /app/error_shots && \
    chown -R pwuser:pwuser /app

USER pwuser

# Sensible defaults; override in Coolify/ENV if you want
ENV NODE_ENV=production \
    HEADLESS=true \
    SLOWMO_MS=0 \
    LOAD_STATE=networkidle

# If you’ll run in idle/server mode (optional, harmless otherwise)
EXPOSE 3889

# Start your script (assumes file is named exactly "playwright-runner.cjs")
# For one-shot: ["node","playwright-runner.cjs","run"]
# For idle API server: ["node","playwright-runner.cjs","server"]
CMD ["node", "playwright-runner.cjs", "server"]
