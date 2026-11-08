import type { ArchitectureDocument } from "./document.js";
import type { NodeFact } from "./facts.js";

type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];
type Point = [number, number];
type Direction = 0 | 1 | 2;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface GridPoint {
  x: number;
  y: number;
}

interface Neighbor {
  index: number;
  direction: Exclude<Direction, 0>;
  distance: number;
}

const runtimeOrder: Record<string, number> = { frontend: 0, api: 1, agent: 2, worker: 3, cli: 4 };

function center(component: Component): GridPoint {
  return { x: component.pos[0] + component.size[0] / 2, y: component.pos[1] + component.size[1] / 2 };
}

function expandedRect(component: Component, padding = 20): Rect {
  return {
    left: component.pos[0] - padding,
    right: component.pos[0] + component.size[0] + padding,
    top: component.pos[1] - padding,
    bottom: component.pos[1] + component.size[1] + padding,
  };
}

function inside(point: GridPoint, rect: Rect) {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

function clearSegment(a: GridPoint, b: GridPoint, obstacles: Rect[]) {
  const horizontal = a.y === b.y;
  const vertical = a.x === b.x;
  if (!horizontal && !vertical) return false;
  return obstacles.every((rect) => {
    if (horizontal) {
      const clearY = a.y <= rect.top || a.y >= rect.bottom;
      const separatedX = Math.max(a.x, b.x) <= rect.left || Math.min(a.x, b.x) >= rect.right;
      return clearY || separatedX;
    }
    const clearX = a.x <= rect.left || a.x >= rect.right;
    const separatedY = Math.max(a.y, b.y) <= rect.top || Math.min(a.y, b.y) >= rect.bottom;
    return clearX || separatedY;
  });
}

function ports(component: Component) {
  const rect = expandedRect(component);
  const point = center(component);
  return [
    { x: rect.left, y: point.y },
    { x: rect.right, y: point.y },
    { x: point.x, y: rect.top },
    { x: point.x, y: rect.bottom },
  ];
}

function graphPoints(components: Component[], source: Component, target: Component) {
  const obstacles = components.map((component) => expandedRect(component));
  const sourcePorts = ports(source);
  const targetPorts = ports(target);
  const endpointPoints = [...sourcePorts, ...targetPorts];
  const xs = [...new Set([...obstacles.flatMap((rect) => [rect.left, rect.right]), ...endpointPoints.map((point) => point.x)])].sort((a, b) => a - b);
  const ys = [...new Set([...obstacles.flatMap((rect) => [rect.top, rect.bottom]), ...endpointPoints.map((point) => point.y)])].sort((a, b) => a - b);
  const points = xs.flatMap((x) => ys.map((y) => ({ x, y }))).filter((point) => obstacles.every((rect) => !inside(point, rect)));
  return { points, obstacles, sourcePorts, targetPorts };
}

function buildNeighbors(points: GridPoint[], obstacles: Rect[]) {
  const neighbors = new Map<number, Neighbor[]>(points.map((_, index) => [index, []]));
  for (const [first, a] of points.entries()) {
    for (let second = first + 1; second < points.length; second += 1) {
      const b = points[second];
      if (!clearSegment(a, b, obstacles)) continue;
      const direction = a.y === b.y ? 1 : 2;
      const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      neighbors.get(first)!.push({ index: second, direction, distance });
      neighbors.get(second)!.push({ index: first, direction, distance });
    }
  }
  return neighbors;
}

function stateKey(index: number, direction: Direction) {
  return `${index}:${direction}`;
}

function simplifyPath(path: GridPoint[]) {
  return path.filter((point, index, values) => {
    if (index === 0 || index === values.length - 1) return true;
    const previousPoint = values[index - 1];
    const nextPoint = values[index + 1];
    return !((previousPoint.x === point.x && point.x === nextPoint.x) || (previousPoint.y === point.y && point.y === nextPoint.y));
  });
}

function stateHeuristic(points: GridPoint[], index: number, target: GridPoint) {
  return Math.abs(points[index].x - target.x) + Math.abs(points[index].y - target.y);
}

function stateScore(key: string, distances: Map<string, number>, points: GridPoint[], target: GridPoint) {
  return (distances.get(key) ?? Number.POSITIVE_INFINITY) + stateHeuristic(points, Number(key.split(":")[0]), target);
}

function selectState(open: Set<string>, distances: Map<string, number>, points: GridPoint[], target: GridPoint) {
  return [...open].sort((a, b) => stateScore(a, distances, points, target) - stateScore(b, distances, points, target) || a.localeCompare(b))[0];
}

function relaxNeighbors(current: string, neighbors: Map<number, Neighbor[]>, distances: Map<string, number>, previous: Map<string, string>, open: Set<string>) {
  const [indexText, directionText] = current.split(":");
  const index = Number(indexText);
  const direction = Number(directionText) as Direction;
  const distance = distances.get(current)!;
  for (const neighbor of neighbors.get(index)!) {
    const bend = direction !== 0 && direction !== neighbor.direction ? 40 : 0;
    const candidate = distance + neighbor.distance + bend;
    const key = stateKey(neighbor.index, neighbor.direction);
    if (candidate >= (distances.get(key) ?? Number.POSITIVE_INFINITY)) continue;
    distances.set(key, candidate);
    previous.set(key, current);
    open.add(key);
  }
}

function reconstructPath(terminal: string, points: GridPoint[], previous: Map<string, string>, source: Component, target: Component) {
  const path: GridPoint[] = [];
  let current = terminal;
  while (true) {
    path.push(points[Number(current.split(":")[0])]);
    const parent = previous.get(current);
    if (parent === undefined) break;
    current = parent;
  }
  return simplifyPath([center(source), ...path.reverse(), center(target)]);
}

function findPath(components: Component[], source: Component, target: Component): GridPoint[] {
  const { points, obstacles, sourcePorts, targetPorts } = graphPoints(components, source, target);
  const targetCenter = center(target);
  const pointIndex = (candidate: GridPoint) => points.findIndex((point) => point.x === candidate.x && point.y === candidate.y);
  const targetIndexes = new Set(targetPorts.map(pointIndex));
  const neighbors = buildNeighbors(points, obstacles);
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const open = new Set<string>();
  for (const port of sourcePorts) {
    const index = pointIndex(port);
    const key = stateKey(index, 0);
    distances.set(key, stateHeuristic(points, index, center(source)));
    open.add(key);
  }
  while (open.size) {
    const current = selectState(open, distances, points, targetCenter);
    open.delete(current);
    if (targetIndexes.has(Number(current.split(":")[0]))) return reconstructPath(current, points, previous, source, target);
    relaxNeighbors(current, neighbors, distances, previous, open);
  }
  throw new Error(`No clear architecture route: ${source.id} -> ${target.id}`);
}

type Side = "left" | "right" | "top" | "bottom";
const oppositeSide: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

function direction(from: GridPoint, to: GridPoint): Side {
  if (to.x > from.x) return "right";
  if (to.x < from.x) return "left";
  return to.y > from.y ? "bottom" : "top";
}

function targetDirection(from: GridPoint, to: GridPoint): Side {
  return oppositeSide[direction(from, to)];
}

function overlaps(first: Rect, second: Rect) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

interface LabelPlacement { point: Point; rect: Rect }
interface Segment { point: GridPoint; next: GridPoint; index: number }

function pathSegments(path: GridPoint[]): Segment[] {
  const length = (segment: Segment) => Math.abs(segment.next.x - segment.point.x) + Math.abs(segment.next.y - segment.point.y);
  return path.slice(0, -1).map((point, index) => ({ point, next: path[index + 1], index })).sort((a, b) => length(b) - length(a));
}

function clearLabel(candidate: GridPoint, width: number, obstacles: Rect[], occupied: Rect[]): LabelPlacement | undefined {
  const rect = { left: candidate.x - width / 2, right: candidate.x + width / 2, top: candidate.y - 9, bottom: candidate.y + 9 };
  return obstacles.every((item) => !overlaps(rect, item)) && occupied.every((item) => !overlaps(rect, item)) ? { point: [candidate.x, candidate.y], rect } : undefined;
}

function segmentLabel(segment: Segment, width: number, obstacles: Rect[], occupied: Rect[]): LabelPlacement | undefined {
  const horizontal = segment.point.y === segment.next.y;
  for (const fraction of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const midpoint = { x: segment.point.x + (segment.next.x - segment.point.x) * fraction, y: segment.point.y + (segment.next.y - segment.point.y) * fraction };
    for (const offset of [18, 36, 56, 80, 120, 180]) {
      for (const sign of [1, -1]) {
        const candidate = { x: midpoint.x + (horizontal ? 0 : sign * offset), y: midpoint.y + (horizontal ? sign * offset : 0) };
        const placement = clearLabel(candidate, width, obstacles, occupied);
        if (placement) return placement;
      }
    }
  }
  return undefined;
}

function labelWidth(label: string) {
  return Math.max(40, Array.from(label).reduce((value, character) => value + (character.charCodeAt(0) > 255 ? 9 : 5), 18));
}

function labelPosition(path: GridPoint[], components: Component[], label: string, occupied: Rect[]): LabelPlacement {
  const obstacles = components.map((component) => expandedRect(component, 8));
  const width = labelWidth(label);
  for (const segment of pathSegments(path)) {
    const placement = segmentLabel(segment, width, obstacles, occupied);
    if (placement) return placement;
  }
  throw new Error(`No clear architecture label position: ${label}`);
}

function laneComponents(components: Component[], roles: Map<string, NodeFact["kind"]>, roots: Set<string>) {
  const rank = (id: string) => {
    const role = roles.get(id);
    return role === undefined ? undefined : runtimeOrder[role];
  };
  const actors = components.filter((component) => roles.get(component.id) === "user" || (roles.get(component.id) === "external" && roots.has(component.id)));
  const runtimes = components.filter((component) => rank(component.id) !== undefined).sort((a, b) => (rank(a.id)! - rank(b.id)!) || a.id.localeCompare(b.id));
  const resources = components.filter((component) => !actors.includes(component) && !runtimes.includes(component));
  return [
    { nodes: actors, x: 60 },
    { nodes: runtimes, x: 540 },
    { nodes: resources, x: 900 },
  ];
}

function connectionLabel(connection: Pick<Connection, "id" | "label">) {
  return connection.label || connection.id;
}

function architectureViewBox(components: Component[], routed: Connection[]): [number, number] {
  const allPoints: Point[] = [
    ...components.map((component): Point => { const point = center(component); return [point.x, point.y]; }),
    ...routed.flatMap((connection): Point[] => [connection.labelAt!, ...connection.via!]),
  ];
  const maxX = Math.max(...allPoints.map((point) => point[0]), ...components.map((component) => component.pos[0] + component.size[0]));
  const maxY = Math.max(...allPoints.map((point) => point[1]), ...components.map((component) => component.pos[1] + component.size[1]));
  return [Math.ceil(maxX + 100), Math.ceil(maxY + 100)];
}

export const architectureLayoutInternals = {
  center,
  expandedRect,
  inside,
  clearSegment,
  ports,
  graphPoints,
  buildNeighbors,
  stateHeuristic,
  stateScore,
  selectState,
  relaxNeighbors,
  direction,
  targetDirection,
  overlaps,
  pathSegments,
  clearLabel,
  segmentLabel,
  labelWidth,
  connectionLabel,
  architectureViewBox,
};

export function layoutArchitecture(components: Component[], connections: Connection[], roles: Map<string, NodeFact["kind"]>, roots: Set<string>) {
  const lanes = laneComponents(components, roles, roots);
  for (const lane of lanes) {
    lane.nodes.forEach((component, index) => {
      component.pos = [lane.x, 80 + index * 180];
    });
  }
  const byId = new Map(components.map((component) => [component.id, component]));
  const occupiedLabels: Rect[] = [];
  const routed = connections.map((connection) => {
    const source = byId.get(connection.from)!;
    const target = byId.get(connection.to)!;
    const path = findPath(components, source, target);
    const label = labelPosition(path, components, connectionLabel(connection), occupiedLabels);
    occupiedLabels.push(label.rect);
    return {
      ...connection,
      fromSide: direction(path[0], path[1]),
      toSide: targetDirection(path[path.length - 2], path[path.length - 1]),
      via: path.slice(1, -1).map((point): Point => [point.x, point.y]),
      labelAt: label.point,
    };
  });
  return { components, connections: routed, viewBox: architectureViewBox(components, routed) };
}
