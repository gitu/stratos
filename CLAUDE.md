# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

STRATOS Route Planner — a stratospheric balloon mission planner (React 19 + Vite) that runs entirely in the browser. Live at https://stratos.häh.ch, deployed as Cloudflare Worker static assets.

## Commands

```sh
npm run dev                          # Vite dev server
npm test                             # unit tests (Vitest, sim engine only)
npx vitest run -t "test name"        # run a single unit test
npm run test:e2e                     # Playwright e2e (builds + serves prod on :4173)
npx playwright test -g "pattern"     # run a single e2e test
npm run build                        # production build to dist/
npm run deploy                       # build + wrangler deploy to stratos.häh.ch
```

E2E tests build the production bundle and serve it via `vite preview` on port 4173 (see `playwright.config.js`). One test waits up to 75 s for the real Open-Meteo fetch to complete, so e2e needs network access. Screenshots are written to `screenshots/` and uploaded as CI artifacts for visual verification.

## Architecture

Two source files carry the whole app:

- **`src/sim.js`** — the simulation engine, pure and dependency-free (no React, no DOM). ISA atmosphere, balloon physics (`computePayload` with float-ceiling bisection), the wind model, trajectory integration with altitude steering (`simulate`), launch-point sampling/ranking with Monte Carlo wind ensembles, launch-window scans, and strategy comparison. This is the only unit-tested code (`tests/sim.test.js`).

- **`src/App.jsx`** (~1400 lines) — a single React class component holding all UI state and rendering: the canvas-drawn 3D globe and 2D Mercator map, control panels, mission playback. No state library, no router, no CSS framework (inline styles, IBM Plex Mono aesthetic).

**Wind data flow**: `sim.js` has a synthetic climatology built in (`windAt`, seeded jet streams). On mount, `App.fetchLive()` pulls real GFS pressure-level winds (7 levels, 850–50 hPa, 14-day horizon) from Open-Meteo on a global lat/lon grid, packs them into `Float32Array`s, and injects them via `sim.setLiveField(field)`. When a live field is set, `windAt` interpolates it instead of the synthetic model; `setLiveField(null)` reverts. Tests rely on this seam (`afterEach(() => setLiveField(null))`).

**Open-Meteo rate limit**: the API 429s on bursts. `fetchLive` deliberately uses concurrency 2 and exponential backoff — keep that behavior if touching the fetch code.

**Determinism**: Monte Carlo ensembles use a seeded PRNG (`mulberry`) so rankings and tests are reproducible.

**Incremental planner** (`App.startPlanner`): launch candidates are (point × start day 0..+4) pairs evaluated in small `setTimeout` batches so the ranked list grows live, then the top points' arrival probability is refined one Monte Carlo member at a time (`mcMember`/`mcAggregate` in sim.js), then strategies/launch-window are computed for the selection. A generation counter (`_planGen`) cancels stale runs; selection changes go through the light `recomputeSelection()`, not a full replan. Each ranked point keeps all start-day `variants` (best one mirrored on the result's top-level fields); routes carry their own `t0H`, so playback/wind readouts use `selT0H()`, not the global launch day.

## Deploy

`wrangler.jsonc` serves `./dist` as static assets with SPA fallback on the custom domain `stratos.xn--hh-via.ch` (punycode for stratos.häh.ch). CI (`.github/workflows/ci.yml`) runs unit + e2e on every push; deploy is manual via `npm run deploy`.
