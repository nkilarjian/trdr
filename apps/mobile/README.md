# @trdr/mobile — Expo app (iOS / Android / web)

The alerts feed + card passport, rendered from real model-pipeline output via
`@trdr/ui`. The data is a generated snapshot (`assets/data.json`) so the app runs
in Expo Go with **no server** — regenerate it with `pnpm snapshot` from the repo root.

## Two hard requirements (learned the hard way)

Expo's **Metro bundler** has two incompatibilities with this project's default
environment. Both must hold or bundling fails:

1. **This app uses npm, not pnpm.** Metro cannot resolve pnpm's `node_modules`
   layout (it fails to find `react/index.js` even hoisted). So `apps/mobile` is
   excluded from the pnpm workspace (`pnpm-workspace.yaml`) and installs with npm.
   Shared workspace code (`@trdr/ui`) is consumed straight from source via a Metro
   resolver alias in `metro.config.js` — no workspace symlink involved.
   The Node services keep using pnpm; only this app is npm.

2. **The repo must live OUTSIDE OneDrive.** Metro's file watcher cannot compute
   SHA-1s for source files under OneDrive (its reparse-point placeholders defeat
   the crawler — `Failed to get the SHA-1 for ...`). A vanilla Expo app and this
   app both bundle cleanly from a non-OneDrive path (e.g. `C:\dev\TRDR`).

## Run

```bash
# from a clone located OUTSIDE OneDrive:
cd apps/mobile
npm install
npx expo start            # press w for web, or scan the QR with Expo Go (iOS/Android)
```

Headless bundle check (CI-friendly):

```bash
npm install
npx expo export -p web    # writes dist/ — verified: 201 modules, contains both screens
```

## Notes

- `expo install --check` confirms the React/RN/web versions are SDK-56 aligned.
- The model itself never runs on-device in this build — the client renders a
  snapshot and formats it with `@trdr/ui`. Live API wiring (Fastify `/api/v1/...`)
  is the next step.
