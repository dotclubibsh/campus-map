// Run with: node --test tests/navigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildGraph, buildSteps, createGeoTransform, currentStepIndex, findRoute, floorInstruction, formatDistance,
  polylineLength, progressAlong, snapToGraph, walkingMinutes,
} from '../js/navigation.js';

const locations = JSON.parse(fs.readFileSync(new URL('../data/locations.json', import.meta.url)));
const calibration = locations.find((l) => l.id === 'calibration_data').calibration;

// A square with one long way round and a dead-end island:
//  a --- b
//  |     |
//  d --- c     x --- y
const square = buildGraph({
  nodes: {
    a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, c: { x: 10, z: 10 }, d: { x: 0, z: 10 },
    x: { x: 50, z: 50 }, y: { x: 60, z: 50 },
  },
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['x', 'y']],
});

test('calibration corners convert to their stored model positions', () => {
  const geo = createGeoTransform(calibration.points);
  const halfMetre = 0.5 / geo.metresPerUnit; // The stored corners are not a perfect rectangle
  calibration.points.forEach(({ gps, local }) => {
    const p = geo.gpsToLocal(gps.lat, gps.lng);
    assert.ok(Math.abs(p.x - local.x) < halfMetre);
    assert.ok(Math.abs(p.z - local.z) < halfMetre);
  });
});

test('GPS conversion round-trips to within about 5 metres', () => {
  const geo = createGeoTransform(calibration.points);
  const local = geo.gpsToLocal(17.4225, 78.218);
  const back = geo.localToGps(local.x, local.z);
  assert.ok(Math.abs(back.lat - 17.4225) < 0.00005);
  assert.ok(Math.abs(back.lng - 78.218) < 0.00005);
});

test('a shared pin (6 decimal places) reopens within a metre of where it was dropped', () => {
  const geo = createGeoTransform(calibration.points);
  const dropped = { x: 2.5, z: -4.1 };
  const gps = geo.localToGps(dropped.x, dropped.z);
  const [lat, lng] = `${gps.lat.toFixed(6)},${gps.lng.toFixed(6)}`.split(',').map(Number);
  assert.ok(geo.isInside(lat, lng));
  const reopened = geo.gpsToLocal(lat, lng);
  assert.ok(Math.hypot(reopened.x - dropped.x, reopened.z - dropped.z) * geo.metresPerUnit < 1);
});

test('the model scale matches the expected 38 metres per unit', () => {
  const geo = createGeoTransform(calibration.points);
  assert.ok(geo.metresPerUnit > 36 && geo.metresPerUnit < 40, `${geo.metresPerUnit}`);
});

test('positions outside the calibrated area are reported as off campus', () => {
  const geo = createGeoTransform(calibration.points);
  assert.equal(geo.isInside(17.4225, 78.218), true);
  assert.equal(geo.isInside(17.385, 78.4867), false);
});

test('snapping finds the closest point on a walkway', () => {
  const snap = snapToGraph(square, { x: 5, z: -2 });
  assert.deepEqual(snap.point, { x: 5, z: 0 });
  assert.equal(snap.distance, 2);
});

test('a route takes the shorter way round', () => {
  const route = findRoute(square, { x: 2, z: 0 }, { x: 10, z: 2 });
  assert.deepEqual(route.walkway, [{ x: 2, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 2 }]);
  assert.equal(route.length, 10);
});

test('a route from one point to another on the same walkway stays on it', () => {
  const route = findRoute(square, { x: 2, z: 0 }, { x: 8, z: 0 });
  assert.deepEqual(route.walkway, [{ x: 2, z: 0 }, { x: 8, z: 0 }]);
});

test('route length includes the off-path legs at each end', () => {
  const route = findRoute(square, { x: 2, z: -1 }, { x: 8, z: -1 });
  assert.equal(route.length, 8);
});

test('disconnected walkways give no route instead of a wrong one', () => {
  assert.equal(findRoute(square, { x: 1, z: 0 }, { x: 55, z: 50 }), null);
});

test('an empty graph gives no route', () => {
  assert.equal(findRoute(buildGraph({ nodes: {}, edges: [] }), { x: 0, z: 0 }, { x: 1, z: 1 }), null);
});

test('edges pointing at missing nodes are ignored', () => {
  const graph = buildGraph({ nodes: { a: { x: 0, z: 0 } }, edges: [['a', 'ghost']] });
  assert.equal(graph.edges.length, 0);
});

test('progress reports the distance off the line and what is left', () => {
  const line = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  const p = progressAlong(line, { x: 4, z: 3 });
  assert.equal(p.distance, 3);
  assert.equal(p.remaining, 16);
  assert.equal(polylineLength(line), 20);
});

test('walking time and distance read sensibly', () => {
  assert.equal(walkingMinutes(10), 1);
  assert.equal(walkingMinutes(800), 10);
  assert.equal(formatDistance(847), '850 m');
  assert.equal(formatDistance(1260), '1.3 km');
});

// In this model, north is -x and east is -z.
const stairGraph = buildGraph({
  nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 }, c: { x: -10, z: 0 }, d: { x: -5, z: 8 } },
  edges: [['a', 'b'], ['b', 'c', { stairs: true }], ['a', 'd'], ['d', 'c']],
});

test('bearings match compass directions on this model', () => {
  const geo = createGeoTransform(calibration.points);
  const near = (value, target) => Math.abs(((value - target + 540) % 360) - 180) < 2;
  assert.ok(near(geo.bearing({ x: 0, z: 0 }, { x: -1, z: 0 }), 0));
  assert.ok(near(geo.bearing({ x: 0, z: 0 }, { x: 0, z: -1 }), 90));
  assert.ok(near(geo.bearing({ x: 0, z: 0 }, { x: 1, z: 0 }), 180));
});

test('a compass heading points the right way in the model', () => {
  const geo = createGeoTransform(calibration.points);
  const north = geo.headingToLocal(17.42, 78.218, 0);
  assert.ok(north.x < -0.99);
  const east = geo.headingToLocal(17.42, 78.218, 90);
  assert.ok(east.z < -0.99);
});

test('the shortest route uses stairs and reports where', () => {
  const route = findRoute(stairGraph, { x: 0, z: 0 }, { x: -10, z: 0 });
  assert.equal(route.length, 10);
  assert.deepEqual(route.stairsAt, [{ x: -5, z: 0 }]);
});

test('avoiding stairs takes the longer step-free way', () => {
  const route = findRoute(stairGraph, { x: 0, z: 0 }, { x: -10, z: 0 }, { avoidStairs: true });
  assert.ok(route.length > 10);
  assert.deepEqual(route.stairsAt, []);
  assert.ok(route.walkway.some((p) => p.z === 8));
});

test('no step-free way gives no route', () => {
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: 5, z: 0 }, c: { x: 10, z: 0 } },
    edges: [['a', 'b'], ['b', 'c', { stairs: true }], ['c', 'c']],
  });
  const onlyViaStairs = buildGraph({
    nodes: { ...Object.fromEntries(graph.nodes), d: { x: 10, z: 5 } },
    edges: [['a', 'b'], ['b', 'c', { stairs: true }], ['c', 'd']],
  });
  assert.equal(findRoute(onlyViaStairs, { x: 0, z: 0 }, { x: 10, z: 5 }, { avoidStairs: true }), null);
});

test('steps give a heading, then the correct left and right turns', () => {
  const geo = createGeoTransform(calibration.points);
  // North, then east (a right turn), then north again (a left turn)
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 }, c: { x: -5, z: -5 }, d: { x: -10, z: -5 } },
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd']],
  });
  const route = findRoute(graph, { x: 0, z: 0 }, { x: -10, z: -5 });
  const steps = buildSteps(route, { geo, destinationName: 'Library' });
  assert.match(steps[0].text, /^Head north for/);
  assert.match(steps[1].text, /^Turn right/);
  assert.match(steps[2].text, /^Turn left/);
  assert.equal(steps[3].text, 'Arrive at Library');
  assert.deepEqual(steps.map((s) => s.maneuver), ['straight', 'right', 'left', 'arrive']);
  assert.equal(steps[1].instruction, 'Turn right');
  assert.deepEqual(steps[1].point, { x: -5, z: 0 });
  assert.ok(Math.abs(steps[1].heading - 90) < 2);
});

test('bear and sharp turns get their own manoeuvres', () => {
  const geo = createGeoTransform(calibration.points);
  // North, then north-west (45 degrees: bear left), then east-south-east (150 degrees: sharp right)
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 }, c: { x: -9, z: 4 }, d: { x: -7.7, z: -0.8 } },
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd']],
  });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 0 }, { x: -7.7, z: -0.8 }), { geo });
  assert.deepEqual(steps.map((s) => s.maneuver), ['straight', 'slight-left', 'sharp-right', 'arrive']);
});

test('off-path legs at each end get their own manoeuvres', () => {
  const geo = createGeoTransform(calibration.points);
  const graph = buildGraph({ nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 } }, edges: [['a', 'b']] });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 1 }, { x: -5, z: -1 }), { geo });
  assert.equal(steps[0].maneuver, 'to-path');
  assert.equal(steps[steps.length - 1].maneuver, 'leave-path');
});

test('gentle road curves are not reported as turns', () => {
  const geo = createGeoTransform(calibration.points);
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: -2, z: 0.02 }, c: { x: -4, z: 0 } },
    edges: [['a', 'b'], ['b', 'c']],
  });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 0 }, { x: -4, z: 0 }), { geo });
  assert.equal(steps.length, 2);
});

test('a tiny offset between two turns is not reported as turns', () => {
  const geo = createGeoTransform(calibration.points);
  // North, a jog of about 8 metres east, then north again
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 }, c: { x: -5, z: -0.2 }, d: { x: -10, z: -0.2 } },
    edges: [['a', 'b'], ['b', 'c'], ['c', 'd']],
  });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 0 }, { x: -10, z: -0.2 }), { geo });
  assert.equal(steps.length, 2);
  assert.match(steps[0].text, /^Head north/);
});

test('the first step names a landmark to walk towards', () => {
  const geo = createGeoTransform(calibration.points);
  const graph = buildGraph({ nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 } }, edges: [['a', 'b']] });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 0 }, { x: -5, z: 0 }), {
    geo, landmarks: [{ name: 'Library', x: -5, z: 0 }],
  });
  assert.match(steps[0].text, /towards Library/);
});

test('steps name a landmark at a turn and mention stairs', () => {
  const geo = createGeoTransform(calibration.points);
  const graph = buildGraph({
    nodes: { a: { x: 0, z: 0 }, b: { x: -5, z: 0 }, c: { x: -5, z: -5 } },
    edges: [['a', 'b'], ['b', 'c', { stairs: true }]],
  });
  const steps = buildSteps(findRoute(graph, { x: 0, z: 0 }, { x: -5, z: -5 }), {
    geo, landmarks: [{ name: 'Dome Area', x: -5, z: 0 }],
  });
  assert.match(steps[1].text, /at Dome Area/);
  assert.match(steps[1].text, /stairs/);
});

test('the current step follows the metres left in the trip', () => {
  const steps = [{ remaining: 300 }, { remaining: 200 }, { remaining: 50 }];
  assert.equal(currentStepIndex(steps, 280), 0);
  assert.equal(currentStepIndex(steps, 120), 1);
  assert.equal(currentStepIndex(steps, 10), 2);
});

test('the traced paths give Front Acads to B Block a route of 200-300 metres', () => {
  const geo = createGeoTransform(calibration.points);
  const paths = JSON.parse(fs.readFileSync(new URL('../data/paths.json', import.meta.url)));
  const graph = buildGraph(paths);
  const at = (id) => {
    const c = locations.find((l) => l.id === id).coordinates;
    return { x: c.x, z: c.y };
  };
  const metres = findRoute(graph, at('fac'), at('blk_b')).length * geo.metresPerUnit;
  assert.ok(metres >= 200 && metres <= 320, `${metres}`);
});

test('every mapped place can be reached on the path network', () => {
  const paths = JSON.parse(fs.readFileSync(new URL('../data/paths.json', import.meta.url)));
  const graph = buildGraph(paths);
  const start = { x: 7.17, z: 0.85 };
  locations.filter((l) => l._assignment_type === '2d_coords' && l.coordinates).forEach((l) => {
    const c = Array.isArray(l.coordinates) ? l.coordinates[0] : l.coordinates;
    assert.ok(findRoute(graph, start, { x: c.x, z: c.y }), l.display_name);
  });
});

test('floor directions come from the description text', () => {
  assert.equal(floorInstruction('Academics, Ground Floor'), 'It is on the ground floor.');
  assert.equal(floorInstruction('Academics, 2nd Floor'), 'Go up to the 2nd floor once you enter the building.');
  assert.equal(floorInstruction('Academics, Central Open Area'), '');
  assert.equal(floorInstruction(undefined), '');
});
