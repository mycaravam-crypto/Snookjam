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
    roads/       Road graph and shortest-time routing
    sim/         Traffic simulation and fixed-step clock
    world/       World model, seeded generation, viewport (world↔screen) maths
    build/       Road construction: validation and the drag-to-build controller
    render/      Canvas 2D drawing through an injected context
tests/
  unit/          Vitest tests for UI and game logic
```

The `@app/*` and `@game/*` import aliases point at `src/app` and `src/game`.
A test in `tests/unit/architecture.test.ts` fails if game logic imports Vue
or the app layer.

## Controls

- **Build a road:** press on an existing road, drag to another road, release.
  Works with mouse, touch and stylus (Pointer Events). Endpoints snap to the
  nearest road within ¾ of a tile, and to a junction within ½ a tile.
- While dragging, the preview is **solid green** with a round end when the
  road can be built, and **dashed red** with a cross when it cannot. The status
  line at the bottom says why (e.g. "Roads cannot cross water").
- A road is rejected if it does not start and end on the network, is shorter
  than one tile, duplicates or runs along an existing road, crosses water or
  leaves the map, or crosses another road anywhere except at its ends.
- New roads join the road graph immediately (splitting the roads they attach
  to), so later route queries can use them.

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
  merge, water is impassable). The road tiles become `world.roads`: nodes
  (junctions, dead ends, settlements, portals) and polyline segments.
  `createRoadGraph(world)` turns that into a routable `RoadGraph`, with each
  bend as a node. Node ids are tile indices (`ty * width + tx`), shared by
  world nodes, `settlement.nodeId`/`portal.nodeId` and the graph.
- **Fallback.** If water makes a map unconnectable, generation retries with
  derived seeds (`maxAttempts`, default 8). If all fail, it generates the map
  without water, which is always connectable. `world.generation` records
  the attempts and whether the fallback was used.

## Traffic simulation

`TrafficSim` (src/game/sim) runs at a fixed 20 Hz step through
`FixedStepClock`, so results never depend on frame rate, and draws all
randomness from a seeded source.

- Vehicles enter at tunnel portals with a shortest-time route to another
  portal and are removed when they reach it.
- Each road has one lane per direction. Vehicles keep at least `minGap`
  (1 tile) apart, never overtake, and only enter the next road when it is
  below capacity. Otherwise they wait at the junction, which forms queues.
- Routes are re-planned only at junctions, after the road graph changes, so
  new roads are used without vehicles teleporting or reversing. A vehicle
  with no route waits in the `stuck` state until the graph changes.
- Spawns that cannot enter yet stay pending; a spawn with no route between
  portals is dropped and counted as `unroutable`.
- Defaults: 8 starting vehicles, at most 100 active, one spawn every 4 s
  (adjustable, never below 0.8 s).
- After a road split (`RoadGraph.connect`), call `sim.applySplit(split)` so
  vehicles on the old edge keep their position.

## Tech stack

Vue 3, TypeScript, Vite, and Canvas 2D for the game world. Tests use Vitest,
@vue/test-utils and jsdom. No game engine or physics library.

## License

Apache-2.0, see [LICENSE](LICENSE).
