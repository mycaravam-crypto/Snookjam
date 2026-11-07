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
| `npm test`           | Unit and integration tests once (Vitest + jsdom) |
| `npm run test:watch` | Run the tests in watch mode                     |
| `npm run test:e2e`   | Browser tests against the production build (Playwright, Chromium) |

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
    build/       Road construction: freehand path geometry, validation and the
                 drag-to-build controller
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
- **Build a road:** press on an existing road, draw the road along any path
  (around a lake, say) and release on or near another road. Works with mouse,
  touch and stylus (Pointer Events).
- **Snapping is generous:** the start snaps to the nearest point *along* a
  road within 1¼ tiles (`DEFAULT_SNAP_DISTANCE`, `snapDistance`) and the
  release end within 2 tiles (`endSnapDistance`); either snaps to a junction
  or road end within ½ a tile. Once the end has snapped to a road it stays on
  that road until the pointer is 2½ tiles away (`endSnapRelease`), so jitter
  near another road does not make it jump. All are configurable through
  `constructionOptions`. While the end is in range, a ring marks where the
  road will attach: a square for a junction, a circle for a point along a road.
- Releasing away from any road builds a dead end, which later roads can start
  from or connect to. Crossing an existing road creates a junction there.
- **Traffic lights (#32):** switch the tool from **Road** to **Lights** (top
  left of the map), then tap a junction where three or more roads meet.
  Dashed rings mark the junctions that can take lights. The first tap adds
  lights; tapping lit junctions selects them. The panel sets the green time
  (5, 10 or 15 s) or removes the lights. Works with mouse and touch.
- **Shop:** the **Shop** button (top left, with your coin balance) opens
  the shop. Buy **traffic lights** (15 coins) or a **roundabout** (40
  coins); bought items go into your stock, shown on the **Lights ×n** and
  **Roundabout ×n** tool buttons. Placing one uses it up; removing it puts it
  back in stock. A junction takes either lights or a roundabout, not both.
- **Roundabouts:** pick the **Roundabout** tool and tap a junction where three
  or more roads meet (dashed rings mark them). Tap a roundabout to select it
  and remove it. With none in stock the status line points you to the shop.
- The drawn trajectory is resampled, smoothed to remove jitter and simplified
  into a few straight segments (`src/game/build/path.ts`). Each bend becomes a
  graph node.
- While dragging, the preview is **solid green** with a round end when the
  road can be built, and **dashed red** with a cross when it cannot. The status
  line at the bottom says why (e.g. "Roads cannot cross water").
- A road is rejected if it does not start and end on the network, is shorter
  than one tile, duplicates or runs along an existing road, crosses water or
  leaves the map, crosses another road anywhere except at its ends, crosses
  itself, passes closer than one road width to a road it does not join, or
  meets a road at less than 60° (two-lane roads need room, #22).
- New roads join the road graph immediately and atomically (a rejected road
  changes nothing), splitting the roads they attach to, so later route
  queries can use them. Vehicles re-plan at their next junction.

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
- Junctions describe their approaches, exits and movements (every approach
  to every other road; `src/game/sim/junctions.ts`). Without lights, the box
  goes to whoever reached the stop line first; vehicles that arrived in the
  same step yield to traffic from their right, then go by id.
- Traffic lights run a fixed cycle: opposite approaches share a phase, and
  each green is followed by 1.5 s of all-red clearance (shown amber on the
  approaches that just had green). Only a green approach may claim the box,
  and it still needs room to leave it, so a green never sends a vehicle into
  an occupied junction or a full exit. Each light head shows red, amber and
  green lamps in the usual order with only the lit one bright.
- Vehicles about to turn at a junction blink their indicators on that side.
- A new road can put a junction box around vehicles already standing there.
  Until they have cleared it, only they may claim it (those on roads inside
  the box first), and each only goes once its path through the box clears
  the others.

## Score, coins and the shop

Success pays (`src/game/session/economy.ts`, tuning in `DEFAULT_ECONOMY`):

- Every vehicle that reaches its tunnel scores 10 points and pays 1 coin.
- Finishing a level pays a bonus of 15 + 5 × level coins, plus up to 20
  more the lower the congestion meter is at the end (10 points per bonus
  coin). The level-complete screen shows the bonus; game over shows the
  final score.
- The run starts with 20 coins. Score only goes up; coins are spent in the
  shop. Restarting resets score, coins and stock.
- Items still on the map when a level ends go back into stock for the next
  map.
- Junction upgrades shorten how long a junction box stays closed after each
  vehicle (`junctionClearSec`): a roundabout to 35% (`roundaboutClearFactor`)
  and traffic lights to 50% for the green approach (`signalClearFactor`).
  Under heavy traffic on generated maps, roundabouts on every junction
  carried about 1.8× the vehicles. Lights carried about 25% more on a busy
  crossroads with 15 s greens, but their red and all-red time makes them a
  net loss on quiet or three-way junctions, so place them with care.

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
- Vehicles accelerate and brake rather than starting and stopping instantly
  (#31). Each class has its own acceleration and braking (`VEHICLE_PROFILES`:
  cars 4 / 6 tiles/s², vans 3.2 / 5, trucks 2.2 / 4). A vehicle never drives
  faster than lets it stop before the hard limit ahead (the vehicle in front,
  a stop line, or the end of a road it cannot enter yet), so braking spreads
  back along a queue and vehicles still never overlap. Vehicles leave tunnels
  at cruising speed, and may claim a free junction box once they are within
  braking distance of its stop line, so they roll through clear junctions.
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
without player roads (seeds 1–10): levels 1–2 stay below about 8 %
congestion, level 3 peaks at 5–25 % on the seeds it does not lose (2 of 10
seeds lost), and level 4 is lost on every seed.

## Testing

- **Unit tests** (`tests/unit`) cover each module: world generation,
  road graph and routing, traffic, construction, congestion and lifecycle.
- **Integration tests** (`tests/integration`) run the whole game logic
  together with fixed seeds and fixed 50 ms steps, with no wall-clock timing.
  The core scenario uses seed 10, level 3. Without player roads the level is
  lost (congestion reaches 100 % at 170 s). A single road from (38.5, 7.5) to
  (32.5, 8.5), built 12 s in, completes the level with congestion peaking
  around 8 %, and more vehicles leave the map. If generation, traffic rules
  or balance change, find a new relieving road by trying every valid single
  road on a map that is lost without help.
- **Browser tests** (`tests/e2e`) start the production build with
  `vite preview` and drive Chromium through Playwright along the critical
  flow: start screen → Play → map and moving vehicles → congestion rises
  while roads are blocked and falls when they reopen → drag to build a road,
  which the graph accepts and rerouted traffic uses → invalid drag rejected
  without page scroll or selection → pause/resume (button and `P` key) →
  game over → restart with no leftover roads, time or congestion → level
  complete → next level. `?test` exposes the game controller as
  `window.__snookjam`. Tests use it to read state and to fast-forward the
  simulation in fixed steps; every player action goes through the real UI.
  Install the browser once with `npx playwright install chromium`. CI runs
  these tests in a separate `e2e` job.

**Performance** (Node 22 / headless Chromium in a 4-core Linux container):

- Simulation: with 94–100 active vehicles on a 40 × 30 map, one 50 ms step
  takes about 0.05 ms (integration test).
- Rendering: with about 90 active vehicles on a 1280 × 720 viewport, the game
  runs at 60 fps (mean frame 16.6 ms, p95 16.8 ms; browser test).

**Known limitations.**

- Only Chromium is tested; touch input is covered by unit tests of the
  pointer handling, not by a real touch device.
- The browser tests use the test hook to create a jam and to reach game over
  or level completion quickly. Losing by organic traffic and saving a level by
  building a road are proven deterministically in the integration tests.

## Tech stack

Vue 3, TypeScript, Vite, and Canvas 2D for the game world. Tests use Vitest,
@vue/test-utils and jsdom. No game engine or physics library.

## License

Apache-2.0, see [LICENSE](LICENSE).
