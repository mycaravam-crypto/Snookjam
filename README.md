# Snookjam

A small single-player browser game about keeping traffic flowing through a
procedurally generated rural road network. Cars enter and leave through
off-screen tunnels; you build new road connections to relieve bottlenecks
before the congestion meter hits 100%.

The game runs entirely client-side. There is no backend. See
[#1](https://github.com/mycaravam-crypto/Snookjam/issues/1) for the MVP roadmap.

## Prerequisites

- Node.js 20 or newer (developed on Node 22)
- npm (bundled with Node; `package-lock.json` is the source of truth)

## Setup

```sh
npm ci          # install exact locked dependencies (use `npm install` to update the lockfile)
npm run dev     # start the Vite dev server at http://localhost:5173
```

## Scripts

| Command              | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| `npm run dev`        | Development server with hot reload              |
| `npm run build`      | Type-check, then production build into `dist/`  |
| `npm run preview`    | Serve the production build locally              |
| `npm run typecheck`  | Type-check TypeScript and Vue files (`vue-tsc`) |
| `npm test`           | Run the unit tests once (Vitest + jsdom)        |
| `npm run test:watch` | Run the tests in watch mode                     |

## Project structure

```
src/
  main.ts        App entry point: mounts Vue
  app/           Vue UI: components, styles. May import from src/game.
  game/          Framework-independent game logic (config, and later world,
                 routing, simulation). Must not import Vue, the DOM or src/app.
tests/
  unit/          Vitest tests for UI and game logic
```

The `@app/*` and `@game/*` import aliases point at `src/app` and `src/game`.
A test in `tests/unit/architecture.test.ts` fails if game logic imports Vue
or the app layer.

## Tech stack

Vue 3, TypeScript, Vite, and Canvas 2D for the game world. Tests use Vitest,
@vue/test-utils and jsdom. No game engine or physics library.

## License

Apache-2.0, see [LICENSE](LICENSE).
