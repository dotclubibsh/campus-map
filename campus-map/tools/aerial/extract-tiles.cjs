// Pulls the satellite photo tiles and their ground corners out of assets/model.glb.
// Only needed if the 3D model changes; then run stitch-aerial.py to rebuild campus-aerial.jpg.
//
//   node tools/aerial/extract-tiles.cjs <path-to-three>/examples/jsm/libs/draco/draco_decoder.js
//
// The decoder file ships with the three npm package. Tiles and tiles.json are written to
// tools/aerial/tiles/ (not needed after stitching; safe to delete).
const fs = require('fs');
const path = require('path');
const os = require('os');
// three's package.json marks its files as ES modules, so load a CommonJS copy of the decoder.
const decoderCopy = path.join(os.tmpdir(), 'draco_decoder_for_campus_map.cjs');
fs.copyFileSync(path.resolve(process.argv[2]), decoderCopy);
const DracoDecoderModule = require(decoderCopy);
const glbPath = path.join(__dirname, '..', '..', 'assets', 'model.glb');
const outDir = path.join(__dirname, 'tiles');
fs.mkdirSync(outDir, { recursive: true });
const b = fs.readFileSync(glbPath);
const jsonLen = b.readUInt32LE(12);
const j = JSON.parse(b.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = b.slice(binStart);
const view = i => { const v = j.bufferViews[i]; return bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength); };

function quatApply(q, v) {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

DracoDecoderModule().then(D => {
  const out = [];
  j.nodes.forEach(n => {
    j.meshes[n.mesh].primitives.forEach(pr => {
      const mat = j.materials[pr.material];
      const tex = mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture;
      if (!tex) return;
      const ext = pr.extensions.KHR_draco_mesh_compression;
      const data = view(ext.bufferView);
      const decoder = new D.Decoder();
      const buf = new D.DecoderBuffer(); buf.Init(new Int8Array(data), data.length);
      const mesh = new D.Mesh(); const st = decoder.DecodeBufferToMesh(buf, mesh);
      if (!st.ok()) throw new Error(st.error_msg());
      const read = (id, comps) => {
        const attr = decoder.GetAttributeByUniqueId(mesh, id);
        const arr = new D.DracoFloat32Array(); decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
        const res = []; for (let i = 0; i < mesh.num_points(); i++) { const p = []; for (let c = 0; c < comps; c++) p.push(arr.GetValue(i * comps + c)); res.push(p); }
        D.destroy(arr); return res;
      };
      const pos = read(ext.attributes.POSITION, 3), uv = read(ext.attributes.TEXCOORD_0, 2);
      const s = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1];
      const world = pos.map(p => { const q = quatApply(r, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]); return [q[0] + t[0], q[1] + t[1], q[2] + t[2]]; });
      const srcIndex = j.textures[tex.index].extensions.EXT_texture_webp.source;
      const img = j.images[srcIndex];
      const file = `${mat.name}.webp`;
      fs.writeFileSync(path.join(outDir, file), view(img.bufferView));
      out.push({ name: mat.name, file, points: world.map((w, i) => ({ x: w[0], z: w[2], u: uv[i][0], v: uv[i][1] })) });
      D.destroy(mesh); D.destroy(buf); D.destroy(decoder);
    });
  });
  fs.writeFileSync(path.join(outDir, 'tiles.json'), JSON.stringify(out, null, 1));
  console.log(out.length, 'tiles');
});
