// Metro for the npm-managed mobile app inside a pnpm monorepo.
// The app's own node_modules is a flat npm install (which Metro can crawl).
// Shared workspace code is consumed straight from source via a resolver alias —
// we deliberately do NOT add the pnpm root node_modules to the crawl, because
// Metro can't resolve pnpm's layout (that's why this app uses npm).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the shared source we import (so it lands in Metro's file map). @trdr/ui
// only type-imports @trdr/core, so that import is erased and never resolved.
config.watchFolders = [path.resolve(workspaceRoot, "packages/ui")];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

const ALIASES = {
  "@trdr/ui": path.resolve(workspaceRoot, "packages/ui/src/index.ts"),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = ALIASES[moduleName];
  if (target) {
    return { type: "sourceFile", filePath: target };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
