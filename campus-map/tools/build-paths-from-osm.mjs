// Builds data/paths.json from OpenStreetMap roads, using the map's GPS calibration.
// Usage: node tools/build-paths-from-osm.mjs [saved-overpass-response.json]
//
// Overwrites data/paths.json, so run it only to start again from OSM. Paths added
// with the editor (index.html?edit=paths) are not kept.
import fs from 'node:fs';
import { createGeoTransform } from '../js/navigation.js';

const root = new URL('../', import.meta.url);
const locations = JSON.parse(fs.readFileSync(new URL('data/locations.json', root)));
const { points } = locations.find((l) => l.id === 'calibration_data').calibration;
const geo = createGeoTransform(points);

const lats = points.map((p) => p.gps.lat);
const lngs = points.map((p) => p.gps.lng);
const bbox = [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];

// Public highways are left out: routes should stay on campus roads.
const EXCLUDED = new Set(['primary', 'primary_link', 'trunk', 'motorway']);

async function loadOsm() {
  const saved = process.argv[2];
  if (saved) return JSON.parse(fs.readFileSync(saved, 'utf8'));
  const query = `[out:json][timeout:60];way["highway"](${bbox.join(',')});out geom tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'campus-map-paths' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  return res.json();
}

const osm = await loadOsm();
const nodeIds = new Map();
const nodes = {};
const edgeKeys = new Set();
const edges = [];

const nodeFor = (lat, lng) => {
  const key = `${lat},${lng}`;
  if (!nodeIds.has(key)) {
    const id = `n${nodeIds.size + 1}`;
    nodeIds.set(key, id);
    const { x, z } = geo.gpsToLocal(lat, lng);
    nodes[id] = { x: Number(x.toFixed(4)), z: Number(z.toFixed(4)) };
  }
  return nodeIds.get(key);
};

osm.elements.filter((w) => w.geometry && !EXCLUDED.has(w.tags?.highway)).forEach((way) => {
  for (let i = 1; i < way.geometry.length; i++) {
    const a = way.geometry[i - 1], b = way.geometry[i];
    if (!geo.isInside(a.lat, a.lon) || !geo.isInside(b.lat, b.lon)) continue;
    const ia = nodeFor(a.lat, a.lon), ib = nodeFor(b.lat, b.lon);
    const key = [ia, ib].sort().join('|');
    if (ia !== ib && !edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push([ia, ib]);
    }
  }
});

// Keep only the largest connected network, so every route can be completed.
const neighbours = new Map(Object.keys(nodes).map((id) => [id, []]));
edges.forEach(([a, b]) => { neighbours.get(a).push(b); neighbours.get(b).push(a); });
const seen = new Set();
let largest = [];
const sizes = [];
for (const id of neighbours.keys()) {
  if (seen.has(id)) continue;
  const group = [];
  const stack = [id];
  seen.add(id);
  while (stack.length) {
    const cur = stack.pop();
    group.push(cur);
    neighbours.get(cur).forEach((n) => { if (!seen.has(n)) { seen.add(n); stack.push(n); } });
  }
  sizes.push(group.length);
  if (group.length > largest.length) largest = group;
}
const keep = new Set(largest);

const output = {
  attribution: 'Road data © OpenStreetMap contributors (ODbL)',
  nodes: Object.fromEntries(Object.entries(nodes).filter(([id]) => keep.has(id))),
  edges: edges.filter(([a]) => keep.has(a)),
};
fs.writeFileSync(new URL('data/paths.json', root), JSON.stringify(output));

console.log(`network sizes (points): ${sizes.sort((a, b) => b - a).join(', ')}`);
console.log(`kept ${Object.keys(output.nodes).length} points and ${output.edges.length} edges`);
