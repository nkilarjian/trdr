# TRDR API (Fastify + fair-value model). Host-agnostic container — builds the
# same on Railway / Koyeb / Fly / Render. Runs on mock ESTIMATE values until you
# set EBAY_CLIENT_ID + EBAY_CLIENT_SECRET, then it serves live eBay-backed data.
FROM node:22-slim
WORKDIR /app

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable

# Whole workspace. The API runs its TypeScript via tsx (a devDependency), so we
# install with --prod=false. apps/mobile is excluded via .dockerignore (npm-managed).
COPY . .
RUN pnpm install --prod=false

# The app reads process.env.PORT (hosts inject their own); 3000 is the default.
EXPOSE 3000
CMD ["pnpm", "--filter", "@trdr/api", "start"]
