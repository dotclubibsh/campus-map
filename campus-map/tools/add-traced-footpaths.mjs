// Adds footpaths traced from the map imagery to data/paths.json. Coordinates are model x,z.
// Run after build-paths-from-osm.mjs. Line ends join the nearest existing point or path.
// Later edits should be made with the editor (index.html?edit=paths).
import fs from 'node:fs';

const file = new URL('../data/paths.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file));
const JOIN_NODE = 0.12;
const JOIN_EDGE = 0.3;

const TRACED = [
  // Front Acads: caterpillar walkway to the B Block road
  { points: [[6.84, -2.75], [6.96, -1.19], [7.08, 0.06], [7.19, 0.8]] },
  // Road to the central walkway
  { points: [[6.22, -2.75], [5.2, -1.43], [5.07, -1.03]] },
  // Central north-south walkway, Front Acads to Back Acads caterpillars
  { points: [[6.96, -1.19], [5.71, -1.06], [5.07, -1.03], [4.56, -1], [3.86, -0.92], [3.03, -0.87]] },
  { points: [[3.86, -0.92], [3.52, 0.06], [3.15, 0.15]] },
  // Back Acads caterpillar, T Junction to Back Acads Circle
  { points: [[2.75, -3.23], [3, -2.56], [3.03, -0.87], [3.15, 0.15], [3.17, 0.33], [3.26, 0.75], [3.1, 1.04]] },
  { points: [[3.1, 1.04], [2.87, 1.18]] },
  // T Junction south to the Birthday Point road
  { points: [[3, -2.56], [1.96, -2.49], [0.53, -2.37], [0.18, -2.37]] },
  // Back Acads, around QRS Girls Hostel
  { points: [[3.17, 0.33], [2.66, -0.31], [2.29, -1.24], [1.82, -1.89], [1.41, -2.03], [0.57, -2.31], [0.53, -2.37]] },
  // Short link near G&H Hostel
  { points: [[0.99, -3.88], [0.2, -3.56]] },
  { points: [[1.66, -6.15], [1.66, -5.82], [1.01, -5.5], [0.96, -4.44]] },
  // Back Acads Circle, east side of the block, Front Acads road
  { points: [[3.1, 1.04], [3.12, 1.82], [2.88, 2.62], [3.44, 3.08], [3.53, 3.92], [4.96, 3.82], [6.72, 3.73], [7.32, 3.64], [7.19, 1.56], [7.19, 0.8]] },
  // Through the academic block by the Spanish stairs
  { points: [[7.19, 0.8], [6.71, 1.01]] },
  { points: [[6.71, 1.01], [6.2, 1.33]], stairs: true },
  { points: [[6.2, 1.33], [4.6, 1.33], [4.3, 1.25]] },
  { points: [[4.3, 1.25], [3.91, 1.18]], stairs: true },
  { points: [[3.91, 1.18], [3.1, 1.04]] },
  // Sports complex and Law School
  { points: [[-0.01, -4.43], [-0.8, -4.39], [-1.14, -4.39], [-1.37, -5.08], [-3.82, -4.94], [-4.06, -6.75]] },
  { points: [[-4.29, -7.49], [-4.08, -7.21], [-4.06, -6.75], [-4.89, -6.75], [-4.92, -7.03]] },
  { points: [[-4.08, -7.21], [-3.36, -7.58]] },
  { points: [[-4.89, -6.75], [-4.89, -5.27]] },
  // BB Block
  { points: [[1.75, 4.16], [0.46, 4.27], [-0.11, 4.3]] },
  { points: [[0.46, 4.27], [0.03, 4.81]] },
  // Cricket ground road
  { points: [[-1.41, 2.58], [-1.55, 0.9]] },
  // Mess 1 side of ABCD Hostel
  { points: [[6.39, -2.83], [6.34, -3.94], [5.93, -4.5]] },
];

let nextId = Object.keys(data.nodes).reduce((max, id) => Math.max(max, parseInt(id.slice(1), 10) || 0), 0) + 1;

function addNode(x, z) {
  const id = `n${nextId++}`;
  data.nodes[id] = { x, z };
  return id;
}

function nodeAt(x, z, isEnd) {
  let best = null, bestD = isEnd ? JOIN_NODE : 0.05;
  Object.entries(data.nodes).forEach(([id, p]) => {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) { best = id; bestD = d; }
  });
  if (best) return best;
  if (!isEnd) return addNode(x, z);

  // Join the closest path by splitting it at the closest point.
  let edgeIndex = -1, edgeD = JOIN_EDGE, joint = null;
  data.edges.forEach((edge, i) => {
    const a = data.nodes[edge[0]], b = data.nodes[edge[1]];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = dx * dx + dz * dz;
    if (!len) return;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len));
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < edgeD) { edgeD = d; edgeIndex = i; joint = { x: Number(px.toFixed(4)), z: Number(pz.toFixed(4)) }; }
  });
  if (edgeIndex < 0) return addNode(x, z);
  const [a, b, attrs] = data.edges[edgeIndex];
  const id = addNode(joint.x, joint.z);
  const split = attrs ? [[a, id, attrs], [id, b, attrs]] : [[a, id], [id, b]];
  data.edges.splice(edgeIndex, 1, ...split);
  return id;
}

TRACED.forEach(({ points, stairs }) => {
  let prev = null;
  points.forEach(([x, z], i) => {
    const id = nodeAt(x, z, i === 0 || i === points.length - 1);
    if (prev && prev !== id) data.edges.push(stairs ? [prev, id, { stairs: true }] : [prev, id]);
    prev = id;
  });
});

data.attribution = 'Road data © OpenStreetMap contributors (ODbL). Footpaths traced from the campus map imagery.';
fs.writeFileSync(file, JSON.stringify(data));
console.log(`now ${Object.keys(data.nodes).length} points and ${data.edges.length} edges`);
