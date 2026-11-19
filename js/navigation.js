// Route finding and GPS conversion for the campus map.
// No Three.js or DOM in here, so it can be tested with plain Node.

const EARTH_RADIUS_M = 6371000;
const WALKING_METRES_PER_MIN = 80;

function haversineMetres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// --- GPS <-> MODEL COORDINATES ---
// Uses the four corner points stored in calibration_data.
export function createGeoTransform(points) {
  const lats = points.map((p) => p.gps.lat);
  const lngs = points.map((p) => p.gps.lng);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lngMin = Math.min(...lngs), lngMax = Math.max(...lngs);

  const corner = (lat, lng) => points.reduce((best, p) => {
    const d = Math.hypot(p.gps.lat - lat, p.gps.lng - lng);
    return d < best.d ? { d, local: p.local } : best;
  }, { d: Infinity, local: null }).local;

  const sw = corner(latMin, lngMin), nw = corner(latMax, lngMin);
  const ne = corner(latMax, lngMax), se = corner(latMin, lngMax);

  const gpsToLocal = (lat, lng) => {
    const t = (lat - latMin) / (latMax - latMin);
    const u = (lng - lngMin) / (lngMax - lngMin);
    const mix = (a, b, c, d) => a * (1 - t) * (1 - u) + b * t * (1 - u) + c * t * u + d * (1 - t) * u;
    return { x: mix(sw.x, nw.x, ne.x, se.x), z: mix(sw.z, nw.z, ne.z, se.z) };
  };

  const localToGps = (x, z) => {
    const south = (sw.x + se.x) / 2, north = (nw.x + ne.x) / 2;
    const west = (sw.z + nw.z) / 2, east = (se.z + ne.z) / 2;
    return {
      lat: latMin + ((x - south) / (north - south)) * (latMax - latMin),
      lng: lngMin + ((z - west) / (east - west)) * (lngMax - lngMin),
    };
  };

  const isInside = (lat, lng) => lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax;

  // Compass bearing in degrees (0 = north, 90 = east) from one model position to another.
  const bearing = (a, b) => {
    const ga = localToGps(a.x, a.z), gb = localToGps(b.x, b.z);
    const east = (gb.lng - ga.lng) * Math.cos((ga.lat * Math.PI) / 180);
    return ((Math.atan2(east, gb.lat - ga.lat) * 180) / Math.PI + 360) % 360;
  };

  // Direction in the model for a compass heading, as a unit vector.
  const headingToLocal = (lat, lng, degrees) => {
    const step = 0.0001;
    const origin = gpsToLocal(lat, lng);
    const north = gpsToLocal(lat + step, lng);
    const east = gpsToLocal(lat, lng + step / Math.cos((lat * Math.PI) / 180));
    const rad = (degrees * Math.PI) / 180;
    const x = (north.x - origin.x) * Math.cos(rad) + (east.x - origin.x) * Math.sin(rad);
    const z = (north.z - origin.z) * Math.cos(rad) + (east.z - origin.z) * Math.sin(rad);
    const len = Math.hypot(x, z);
    return { x: x / len, z: z / len };
  };

  const edges = [[sw, nw], [nw, ne], [ne, se], [se, sw]];
  const gpsOf = (local) => points.find((p) => p.local === local).gps;
  const metresPerUnit = edges.reduce((sum, [a, b]) =>
    sum + haversineMetres(gpsOf(a), gpsOf(b)) / dist(a, b), 0) / edges.length;

  return { gpsToLocal, localToGps, isInside, bearing, headingToLocal, metresPerUnit };
}

// --- WALKWAY GRAPH ---
export function buildGraph(data) {
  const nodes = new Map(Object.entries(data.nodes));
  const adjacency = new Map();
  const edges = [];
  nodes.forEach((_, id) => adjacency.set(id, []));

  data.edges.forEach(([a, b, attrs]) => {
    const pa = nodes.get(a), pb = nodes.get(b);
    if (!pa || !pb || a === b) return;
    const cost = dist(pa, pb);
    const stairs = Boolean(attrs && attrs.stairs);
    adjacency.get(a).push({ to: b, cost, stairs });
    adjacency.get(b).push({ to: a, cost, stairs });
    edges.push({ a, b, stairs });
  });

  return { nodes, adjacency, edges };
}

// Closest point on any walkway to a position.
export function snapToGraph(graph, point, { avoidStairs = false } = {}) {
  let best = null;
  graph.edges.forEach(({ a, b, stairs }) => {
    if (avoidStairs && stairs) return;
    const pa = graph.nodes.get(a), pb = graph.nodes.get(b);
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const lenSq = dx * dx + dz * dz;
    const raw = lenSq === 0 ? 0 : ((point.x - pa.x) * dx + (point.z - pa.z) * dz) / lenSq;
    const t = Math.max(0, Math.min(1, raw));
    const snapped = { x: pa.x + dx * t, z: pa.z + dz * t };
    const d = dist(point, snapped);
    if (!best || d < best.distance) best = { point: snapped, distance: d, a, b, stairs };
  });
  return best;
}

function dedupe(points) {
  return points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 1e-6);
}

// A* over the walkways. Returns the walkway part of the trip, plus the short
// off-path legs from the start and to the destination, or null if unreachable.
export function findRoute(graph, from, to, { avoidStairs = false } = {}) {
  const start = snapToGraph(graph, from, { avoidStairs });
  const end = snapToGraph(graph, to, { avoidStairs });
  if (!start || !end) return null;
  const sameEdge = (start.a === end.a && start.b === end.b) || (start.a === end.b && start.b === end.a);

  const finish = (walkway, stairsAt) => ({
    from, to, walkway: dedupe(walkway), stairsAt,
    length: polylineLength([from, ...walkway, to]),
  });

  if (sameEdge) return finish([start.point, end.point], start.stairs ? [start.point] : []);

  const endLinks = new Map([
    [end.a, dist(graph.nodes.get(end.a), end.point)],
    [end.b, dist(graph.nodes.get(end.b), end.point)],
  ]);
  const heuristic = (id) => dist(graph.nodes.get(id), end.point);

  const cost = new Map();
  const cameFrom = new Map();
  const open = new Set();
  [start.a, start.b].forEach((id) => {
    const c = dist(start.point, graph.nodes.get(id));
    if (!cost.has(id) || c < cost.get(id)) cost.set(id, c);
    open.add(id);
  });

  let bestTotal = Infinity;
  let bestLast = null;

  while (open.size > 0) {
    let current = null, currentScore = Infinity;
    open.forEach((id) => {
      const score = cost.get(id) + heuristic(id);
      if (score < currentScore) { current = id; currentScore = score; }
    });
    if (currentScore >= bestTotal) break;
    open.delete(current);

    if (endLinks.has(current)) {
      const total = cost.get(current) + endLinks.get(current);
      if (total < bestTotal) { bestTotal = total; bestLast = current; }
    }

    graph.adjacency.get(current).forEach(({ to: next, cost: step, stairs }) => {
      if (avoidStairs && stairs) return;
      const candidate = cost.get(current) + step;
      if (!cost.has(next) || candidate < cost.get(next)) {
        cost.set(next, candidate);
        cameFrom.set(next, current);
        open.add(next);
      }
    });
  }

  if (bestLast === null) return null;

  const ids = [bestLast];
  while (cameFrom.has(ids[0])) ids.unshift(cameFrom.get(ids[0]));

  const stairsAt = start.stairs ? [start.point] : [];
  ids.forEach((id, i) => {
    if (i === 0) return;
    const link = graph.adjacency.get(ids[i - 1]).find((l) => l.to === id);
    if (link && link.stairs) stairsAt.push(graph.nodes.get(ids[i - 1]));
  });
  if (end.stairs) stairsAt.push(graph.nodes.get(bestLast));

  return finish([start.point, ...ids.map((id) => graph.nodes.get(id)), end.point], stairsAt);
}

// --- TURN-BY-TURN STEPS ---
const STRAIGHT_DEGREES = 30;
const BEAR_DEGREES = 60;
const TURN_DEGREES = 135;
const SIMPLIFY_METRES = 10;    // Road curves smaller than this are not treated as turns
const WALK_TO_PATH_METRES = 15;
const LANDMARK_METRES = 30;
const SHORT_LEG_METRES = 20;

function pointLineDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

function simplifyLine(points, tolerance) {
  if (points.length < 3) return points;
  let furthest = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], points[0], points[points.length - 1]);
    if (d > furthest) { furthest = d; index = i; }
  }
  if (furthest <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyLine(points.slice(0, index + 1), tolerance);
  const right = simplifyLine(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function compassWord(degrees) {
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return words[Math.round(degrees / 45) % 8];
}

function turnWords(delta) {
  const side = delta > 0 ? 'right' : 'left';
  const size = Math.abs(delta);
  if (size < BEAR_DEGREES) return `Bear ${side}`;
  if (size < TURN_DEGREES) return `Turn ${side}`;
  return `Make a sharp ${side}`;
}

function turnManeuver(delta) {
  const side = delta > 0 ? 'right' : 'left';
  const size = Math.abs(delta);
  if (size < BEAR_DEGREES) return `slight-${side}`;
  if (size < TURN_DEGREES) return side;
  return `sharp-${side}`;
}

// Each step has text, its length in metres, and `remaining`: the metres left in
// the trip when that step begins, used to follow progress on GPS. For the
// navigation banner it also has a short `instruction`, a `maneuver` (straight,
// left, slight-right, sharp-left, to-path, leave-path, arrive...), the `point`
// where it begins, the compass `heading` to walk in, and `stairs`.
export function buildSteps(route, { geo, landmarks = [], destinationName = 'your destination' }) {
  const mpu = geo.metresPerUnit;
  const line = simplifyLine(route.walkway, SIMPLIFY_METRES / mpu);
  const startLeg = dist(route.from, route.walkway[0]) * mpu;
  const endLeg = dist(route.walkway[route.walkway.length - 1], route.to) * mpu;
  const total = route.length * mpu;
  const steps = [];
  let walked = 0;

  const addStep = (text, metres, details) => {
    steps.push({ text, metres, remaining: total - walked, stairs: false, ...details });
    walked += metres;
  };
  const landmarkNear = (point) => {
    let best = null, bestD = LANDMARK_METRES / mpu;
    landmarks.forEach((l) => {
      const d = dist(l, point);
      if (d < bestD) { best = l.name; bestD = d; }
    });
    return best;
  };

  if (startLeg > WALK_TO_PATH_METRES) {
    addStep(`Walk ${formatDistance(startLeg)} to the nearest path`, startLeg, {
      instruction: 'Walk to the nearest path', maneuver: 'to-path',
      point: route.from, heading: geo.bearing(route.from, route.walkway[0]),
    });
  }

  // Merge nearly straight legs, then describe each leg with the turn that begins it.
  const legs = [];
  for (let i = 1; i < line.length; i++) {
    const metres = dist(line[i - 1], line[i]) * mpu;
    const heading = geo.bearing(line[i - 1], line[i]);
    const previous = legs[legs.length - 1];
    if (previous) {
      const delta = ((heading - previous.lastHeading + 540) % 360) - 180;
      if (Math.abs(delta) < STRAIGHT_DEGREES) {
        previous.metres += metres;
        previous.lastHeading = heading;
        previous.end = line[i];
        continue;
      }
      legs.push({ start: line[i - 1], end: line[i], metres, heading, lastHeading: heading, delta });
    } else {
      legs.push({ start: line[0], end: line[i], metres, heading, lastHeading: heading, delta: null });
    }
  }

  // A very short leg between two turns is usually just a small offset where paths
  // join, not a real turn, so absorb it and work out the turn again.
  const cleaned = [];
  legs.forEach((leg, i) => {
    const previous = cleaned[cleaned.length - 1];
    const hasNext = i < legs.length - 1;
    if (previous && hasNext && leg.metres < SHORT_LEG_METRES) {
      previous.metres += leg.metres;
      previous.end = leg.end;
      return;
    }
    if (previous) {
      const delta = ((leg.heading - previous.lastHeading + 540) % 360) - 180;
      if (Math.abs(delta) < STRAIGHT_DEGREES) {
        previous.metres += leg.metres;
        previous.end = leg.end;
        previous.lastHeading = leg.lastHeading;
        return;
      }
      leg.delta = delta;
    }
    cleaned.push(leg);
  });

  cleaned.forEach((leg) => {
    const hasStairs = route.stairsAt.some((p) => progressAlong([leg.start, leg.end], p).distance * mpu < SIMPLIFY_METRES);
    const near = landmarkNear(leg.start);
    const walk = `walk ${formatDistance(leg.metres)}`;
    let text, instruction, maneuver;
    if (leg.delta === null) {
      const ahead = landmarkNear(leg.end);
      const towards = ahead !== landmarkNear(leg.start) ? ahead : null;
      instruction = `Head ${compassWord(leg.heading)}${towards ? ` towards ${towards}` : ''}`;
      text = `${instruction} for ${formatDistance(leg.metres)}`;
      maneuver = 'straight';
    } else {
      instruction = `${turnWords(leg.delta)}${near ? ` at ${near}` : ''}`;
      text = `${instruction} and ${walk}`;
      maneuver = turnManeuver(leg.delta);
    }
    addStep(hasStairs ? `${text}, using the stairs on the way` : text, leg.metres, {
      instruction, maneuver, point: leg.start, heading: leg.heading, stairs: hasStairs,
    });
  });

  const last = route.walkway[route.walkway.length - 1];
  if (endLeg > WALK_TO_PATH_METRES) {
    addStep(`Leave the path and go ${formatDistance(endLeg)} to ${destinationName}`, endLeg, {
      instruction: `Leave the path towards ${destinationName}`, maneuver: 'leave-path',
      point: last, heading: geo.bearing(last, route.to),
    });
  } else {
    addStep(`Arrive at ${destinationName}`, endLeg, {
      instruction: `Arrive at ${destinationName}`, maneuver: 'arrive',
      point: route.to, heading: geo.bearing(route.walkway[0], route.to),
    });
  }
  return steps;
}

// The step to follow now, from the metres left in the trip.
export function currentStepIndex(steps, remainingMetres) {
  let index = 0;
  steps.forEach((step, i) => { if (step.remaining >= remainingMetres) index = i; });
  return index;
}

// --- MEASUREMENTS ---
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

// Distance from a position to a polyline, and how much of the line is left after it.
export function progressAlong(points, position) {
  let best = { distance: Infinity, remaining: polylineLength(points) };
  let walked = 0;
  const total = best.remaining;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const segment = Math.hypot(dx, dz);
    const raw = segment === 0 ? 0 : ((position.x - a.x) * dx + (position.z - a.z) * dz) / (segment * segment);
    const t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(position.x - (a.x + dx * t), position.z - (a.z + dz * t));
    if (d < best.distance) best = { distance: d, remaining: total - walked - segment * t };
    walked += segment;
  }
  return best;
}

export function walkingMinutes(metres) {
  return Math.max(1, Math.round(metres / WALKING_METRES_PER_MIN));
}

export function formatDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 10) * 10} m`;
}

// Floors are only stored in the description text, e.g. "Academics, 2nd Floor".
export function floorInstruction(description) {
  const match = (description || '').match(/\b(ground|\d+(?:st|nd|rd|th))\s+floor\b/i);
  if (!match) return '';
  const floor = match[1].toLowerCase();
  if (floor === 'ground') return 'It is on the ground floor.';
  return `Go up to the ${floor} floor once you enter the building.`;
}
