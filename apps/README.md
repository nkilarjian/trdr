# Clients

Three targets, maximum shared code via `@trdr/core` (types + view-model logic)
and `@trdr/ui` (shared components):

- **mobile/** — Expo, iOS + Android (React Native + TS)
- **desktop/** — Tauri shell wrapping the RN-Web build
- **web/** — Expo RN-Web → PWA

Phase 0 leaves these as placeholders: the shared core, providers, model, API, and
the end-to-end pipeline all run and are tested headlessly (`pnpm e2e`, `pnpm test`).
Phase 1 scaffolds the Expo app and renders the alerts feed + card passport from
`@trdr/ui` against the API. Wiring the three build targets is the next sign-off
checkpoint.
