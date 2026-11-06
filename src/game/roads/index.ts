/**
 * Road topology and routing (#4). Framework-independent: no Vue, DOM or Canvas.
 *
 * Typical use:
 *   const graph = RoadGraph.fromLayout(world.roads)
 *   const result = findRoute(graph, portalA, portalB)
 *   if (result.ok) follow(result.route.steps)
 *
 *   // Player-built road (#6): snap pointer positions, validate, then connect.
 *   const from = graph.nearestLocation(worldPointA, 1)
 *   const to = graph.nearestLocation(worldPointB, 1)
 *   if (from && to && graph.canConnect(from.location, to.location).ok)
 *     graph.connect(from.location, to.location)
 */
export * from './graph'
export * from './routing'
