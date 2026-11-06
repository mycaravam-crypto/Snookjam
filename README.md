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
  app/           Vue UI. May import from src/game; owns no game rules.
    components/  StartScreen, GameShell (frame loop), GameHud, GameOverlay,
                 WorldCanvas (canvas drawing + pointer input)
    game/        gameController: reactive wrapper around GameSession
  game/          Framework-independent game logic. Must not import Vue or src/app.
    config.ts    MVP tuning defaults
    roads/       Road graph and shortest-time routing
    sim/         Traffic simulation and fixed-step clock
    session/     Congestion model, level progression and game lifecycle
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

- **Start:** press **Play** on the title screen. The run starts immediately.
- **Pause / resume:** the Pause button in the top bar, or <kbd>P</kbd> / <kbd>Esc</kbd>.
  The game also pauses when the tab is hidden. You can still build while paused.
- **HUD:** level, time survived out of the level target, active cars, and the
  congestion meter with its percentage and a text state (Flowing / Warning
  from 50% / Critical from 80%, which is also striped).
- **Portrait screens:** when the screen is tall enough that a quarter turn makes
  the map at least 15% larger, the map is drawn rotated (world north points
  right). This is display-only: the map, seeds and rules are unchanged, and
  pointer input is converted back to world coordinates.
- **Overlays:** Paused (resume, restart, new map, quit), Level complete
  (continue to the next level) and Gridlock (try again, new map, quit).
- **Build a road:** press on an existing road, drag to another road, release.
  Works with mouse, touch and stylus (Pointer Events). Endpoints snap to the
  nearest road within ¾ of a tile, and to a junction within ½ a tile.
- While dragging, the preview is **solid green** with a round end when the
  road can be built, and **dashed red** with a cross when it cannot. The status
  line at the bottom says why (e.g. "Roads cannot cross water").
- A road is rejected if it does not start and end on the network, is shorter
  than one tile, duplicates or runs along an existing road, crosses water or
  leaves the map, crosses another road anywhere except at its ends, passes
  closer than one road width to another road, or meets a road at less than 60°.
- New roads join the road graph immediately (splitting the roads they attach
  to), so later route queries can use them.

## Roads and traffic

Every road is a classic two-lane road: one lane per direction, driving on the
right, with a dashed centre line. Dimensions live in `src/game/sim/lanes.ts`
(`ROAD_GEOMETRY`) and are shared by the simulation, road building and drawing:
lane width 0.38 tiles (road 0.76), cars 0.5 × 0.22 tiles, safety gap 0.06.

- Vehicles keep to their lane and pass oncoming traffic without touching.
  `sim.lanePositionOf(vehicle)` gives the in-lane position; vehicles follow a
  short curve through bends and turns, so they never jump lanes.
- Following distance (1.24 tiles) is kept per lane and across nodes.
- Intersections have a stop line and a junction box that one vehicle holds at
  a time, entering only when it has room to leave. Intersections too close to
  stop between them share one box, so they cannot deadlock. Tunnels where two
  or more roads meet work the same way.

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
- Intersections (three or more roads meeting) let one vehicle through every
  `junctionClearSec` (1.8 s by default), so busy junctions become the
  bottlenecks that new roads relieve. Bends are not limited.
- After a road split (`RoadGraph.connect`), call `sim.applySplit(split)` so
  vehicles on the old edge keep their position.

## Congestion and levels

`GameSession` (src/game/session) owns one run:
`ready → running ⇄ paused`, `running → levelComplete → running (next level)`,
`running → gameOver`, and `restart()` from any state. Time only advances while
running, through the fixed-step clock. Each level gets its own seeded map
(level 1 uses the run seed), a fresh traffic sim and zero congestion.

Congestion (0–100 %) changes every step by `rise − fall`:

- rise = `blockedRatePerSec` × (share of vehicles waiting ≥ `blockedAfterSec`,
  above a `blockedTolerance` share) + `pendingRatePerSec` × (vehicles stuck at
  blocked tunnels / `pendingReference`, capped at 1)
- fall = `exitRelief` per vehicle that leaves + `flowDecayPerSec` × unblocked share
- No rise during the first `levelStartGraceSec` of a level. Reaching 100 %
  ends the run.

Levels last 180 s. The spawn interval starts at 2.5 s, ramps down to 60 % of
that within a level, starts 25 % lower each level, and never drops below
0.8 s. Each level also adds 2 starting vehicles. All values are in
`DEFAULT_BALANCE` (src/game/session/balance.ts). Measured over 10 seeds
without player roads: levels 1–2 stay below about 5 % congestion, level 3
peaks at 20–95 % (2 of 10 seeds lost), and level 4 is lost on every seed.

## Tech stack

Vue 3, TypeScript, Vite, and Canvas 2D for the game world. Tests use Vitest,
@vue/test-utils and jsdom. No game engine or physics library.

## License

Apache-2.0, see [LICENSE](LICENSE).
