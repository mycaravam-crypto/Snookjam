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
  game/          Framework-independent game logic. Must not import Vue or src/app.
    config.ts    MVP tuning defaults
    world/       World model, seeded generation, viewport (world↔screen) maths
    render/      Canvas 2D drawing through an injected context
tests/
  unit/          Vitest tests for UI and game logic
```

The `@app/*` and `@game/*` import aliases point at `src/app` and `src/game`.
A test in `tests/unit/architecture.test.ts` fails if game logic imports Vue
or the app layer.

## World and maps

Maps are generated from a seed: the same seed always gives the same map.
Open `/?seed=1234` (any number or text) to load a specific map; otherwise a
random seed is used and shown in the header. "New map" picks a new one.

- **Coordinates.** World units are tiles. Tile `(tx, ty)` covers
  `[tx, tx+1) × [ty, ty+1)`; its centre is `(tx + 0.5, ty + 0.5)`. The
  viewport (`fitViewport`, `worldToScreen`, `screenToWorld`) maps world
  units to CSS pixels and is recomputed on resize without touching the world.
- **Terrain.** Grass, field, forest, water and settlement tiles from seeded
  value noise. Water is impassable.
- **Settlements and portals.** Five 3 × 3 settlements away from water; four
  tunnel portals on the map edges, one per side.
- **Roads.** A minimum spanning tree over settlements and portals, each edge
  routed with grid A* (forest costs more, existing roads cost less so routes
  merge, water is impassable). The road tiles are converted to a
  `RoadLayout`: nodes (junctions, dead ends, settlements, portals) and
  segments (polylines with a length in tiles) for the road graph.
- **Fallback.** If water makes a map unconnectable, generation retries with
  derived seeds (`maxAttempts`, default 8). If all fail, it generates the map
  without water, which is always connectable. `world.generation` records
  the attempts and whether the fallback was used.

## Tech stack

Vue 3, TypeScript, Vite, and Canvas 2D for the game world. Tests use Vitest,
@vue/test-utils and jsdom. No game engine or physics library.

## License

Apache-2.0, see [LICENSE](LICENSE).
