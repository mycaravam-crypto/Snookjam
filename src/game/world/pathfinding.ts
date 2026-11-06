/**
 * Grid A* used by world generation to lay roads between points.
 * 4-connected; `cost(index)` returns the cost of entering a tile, or
 * Infinity for impassable tiles.
 */
export function findGridPath(
  width: number,
  height: number,
  start: number,
  goal: number,
  cost: (index: number) => number,
  minCost: number,
): number[] | undefined {
  const size = width * height
  const g = new Float64Array(size).fill(Infinity)
  const came = new Int32Array(size).fill(-1)
  const closed = new Uint8Array(size)
  const gx = goal % width
  const gy = Math.floor(goal / width)
  const h = (i: number) => (Math.abs((i % width) - gx) + Math.abs(Math.floor(i / width) - gy)) * minCost
  const heap = new MinHeap()
  g[start] = 0
  heap.push(start, h(start))
  while (heap.size > 0) {
    const current = heap.pop()
    if (current === goal) {
      const path = [goal]
      let at = goal
      while (at !== start) {
        at = came[at]!
        path.push(at)
      }
      return path.reverse()
    }
    if (closed[current]) continue
    closed[current] = 1
    const cx = current % width
    const cy = Math.floor(current / width)
    const neighbours = [
      cy > 0 ? current - width : -1,
      cx < width - 1 ? current + 1 : -1,
      cy < height - 1 ? current + width : -1,
      cx > 0 ? current - 1 : -1,
    ]
    for (const next of neighbours) {
      if (next < 0 || closed[next]) continue
      const step = cost(next)
      if (!Number.isFinite(step)) continue
      const tentative = g[current]! + step
      if (tentative < g[next]!) {
        g[next] = tentative
        came[next] = current
        heap.push(next, tentative + h(next))
      }
    }
  }
  return undefined
}

/** Binary min-heap keyed by priority; ties broken by insertion order. */
class MinHeap {
  private items: { value: number; priority: number; order: number }[] = []
  private counter = 0

  get size(): number {
    return this.items.length
  }

  push(value: number, priority: number): void {
    const items = this.items
    items.push({ value, priority, order: this.counter++ })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): number {
    const items = this.items
    const top = items[0]!
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < items.length && this.less(l, smallest)) smallest = l
        if (r < items.length && this.less(r, smallest)) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top.value
  }

  private less(a: number, b: number): boolean {
    const x = this.items[a]!
    const y = this.items[b]!
    return x.priority < y.priority || (x.priority === y.priority && x.order < y.order)
  }

  private swap(a: number, b: number): void {
    const items = this.items
    ;[items[a], items[b]] = [items[b]!, items[a]!]
  }
}
