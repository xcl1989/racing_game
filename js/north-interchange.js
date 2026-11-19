import * as THREE from 'three';
import { createRoadMaterial } from './roads.js';
import { makeJunctionTextures } from './textures.js';

const auxOffset = -12.3;
const travelOffset = -7.5;
const roadY = 0.035;
const paintY = 0.048;
const width = 6;
const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const vec = (x, z, y = roadY) => new THREE.Vector3(x, y, z);
const sideOf = (t) => vec(t.z, -t.x, 0);

// Lay out the two slips against the *existing* inner carriageway, in its travel direction.
export function buildNorthInterchange(highway, cityZ) {
  const { curve, length, samples } = highway;
  const n = samples.length - 1;
  const at = (s, off, y = roadY) => {
    const t = ((s % length) + length) % length / length;
    return curve.getPointAt(t).addScaledVector(sideOf(curve.getTangentAt(t)), off).setY(y);
  };
  const station = (fraction) => Math.round(n * fraction) * length / n;
  const exitStart = station(.118), exitEnd = station(.137);
  const entryStart = station(.169), entryEnd = station(.190);
  const splitZ = 745;
  const entryCity = vec(1166.5, cityZ), exitCity = vec(1173.5, cityZ);
  const entrySplit = vec(entryCity.x, splitZ), exitSplit = vec(exitCity.x, splitZ);
  const entryJoin = at(entryStart, auxOffset), exitJoin = at(exitEnd, auxOffset);
  const heading = (s) => curve.getTangentAt(s / length).setY(0);
  const exitBend = new THREE.CubicBezierCurve3(exitJoin, exitJoin.clone().addScaledVector(heading(exitEnd), 92),
    vec(exitSplit.x, splitZ + 105), exitSplit);
  const entryBend = new THREE.CubicBezierCurve3(entrySplit, vec(entrySplit.x, splitZ + 112),
    entryJoin.clone().addScaledVector(heading(entryStart), -105), entryJoin);
  const offset = (s, entry) => THREE.MathUtils.lerp(travelOffset, auxOffset,
    smooth((entry ? entryEnd - s : s - exitStart) / 63));

  // Meshes, route samples and the paved footprint all use the same sampled stations.
  const group = new THREE.Group();
  group.name = 'north-interchange';
  const tex = makeJunctionTextures();
  const asphalt = createRoadMaterial('asphalt', { map: tex.map, normalMap: tex.normal,
    roughnessMap: tex.roughness, roughness: .9,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const paint = createRoadMaterial('marking', { color: 0xe3e1d8, polygonOffset: true,
    polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const footprints = [], markings = [];
  const strip = (rows, material, name, layer) => {
    const vertices = [], uv = [], indices = [];
    let dist = 0;
    rows.forEach(([a, b], i) => {
      if (i) dist += a.distanceTo(rows[i - 1][0]);
      vertices.push(...a.toArray(), ...b.toArray());
      uv.push(0, dist / 12, 1, dist / 12);
      if (i) {
        const j = i * 2;
        indices.push(j - 2, j - 1, j, j - 1, j + 1, j);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.renderOrder = layer;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const cross = (p, side, low, high, y) => [p.clone().addScaledVector(side, high).setY(y),
    p.clone().addScaledVector(side, low).setY(y)];
  const subdivide = (from, to, step, fn) => {
    const count = Math.max(1, Math.ceil((to - from) / step));
    return Array.from({ length: count + 1 }, (_, i) => fn(THREE.MathUtils.lerp(from, to, i / count)));
  };
  function mark(from, to, section, dashed = false) {
    for (let s = from; s < to - .05; s += dashed ? 12 : to - from) {
      markings.push(subdivide(s, dashed ? Math.min(s + 4, to) : to, 2, section));
    }
  }
  function paved(rows, name) {
    footprints.push(rows);
    strip(rows, asphalt, name, 1);
  }
  const throat = (s) => vec(1170, s);
  for (const edge of [-6.7, 6.7]) {
    mark(cityZ + 7, splitZ, (s) => cross(throat(s), vec(1, 0, 0), edge - .12, edge + .12, paintY));
  }
  mark(cityZ + 7, splitZ - 2, (s) => cross(throat(s), vec(1, 0, 0), -.12, .12, paintY));
  // Stop the original street texture at the crossing; only overlap its outbound edge.
  paved([cross(throat(cityZ + 5.9), vec(1, 0, 0), -7, 7, roadY),
    cross(throat(splitZ + 1), vec(1, 0, 0), -7, 7, roadY)], 'north-approach');

  function makeBend(bend, entry) {
    const len = bend.getLength();
    const row = (s, lo, hi, y) => {
      const t = s / len;
      // Different elevations avoid coplanar overlaps at the terminals.
      return cross(bend.getPointAt(t), sideOf(bend.getTangentAt(t)), lo, hi, y);
    };
    paved(subdivide(0, len, 2, (s) => row(s, -width / 2, width / 2, .039)),
      entry ? 'entry-slip' : 'exit-slip');
    for (const edge of [-2.8, 2.8]) {
      // The inner connector stripe starts beyond the paired throat.
      const trim = edge === -2.8 ? 5 : 0;
      mark(entry ? trim : 0, len - (entry ? 0 : trim), (s) => row(s, edge - .12, edge + .12, paintY));
    }
    return subdivide(0, len, 3, (s) => bend.getPointAt(s / len));
  }
  function makeAux(from, to, entry) {
    const outer = (s) => -9.45 - 5.85 * smooth((entry ? to - s : s - from) / 58);
    const row = (s, lo, hi, y) => [at(s, hi, y), at(s, lo, y)];
    paved(subdivide(from, to, 2, (s) => row(s, outer(s), -9.35, roadY)),
      entry ? 'acceleration-lane' : 'deceleration-lane');
    mark(from, to, (s) => row(s, outer(s) + .1, outer(s) + .32, paintY));
    mark(from + (entry ? 0 : 12), to - (entry ? 12 : 0),
      (s) => row(s, -9.72, -9.48, paintY), true);
    return subdivide(from, to, 3, (s) => at(s, offset(s, entry)));
  }
  const exitAux = makeAux(exitStart, exitEnd, false), entryAux = makeAux(entryStart, entryEnd, true);
  const off = [...exitAux, ...makeBend(exitBend, false).slice(1), exitCity];
  const on = [entryCity, ...makeBend(entryBend, true), ...entryAux.slice(1)];
  function arrow(p, tan) {
    const side = sideOf(tan);
    const row = (s, half) => cross(p.clone().addScaledVector(tan, s), side, -half, half, paintY);
    markings.push([row(-2.6, .17), row(.3, .17)], [row(.3, .74), row(2.2, 0)]);
  }
  arrow(vec(entrySplit.x, splitZ - 19), vec(0, 1, 0));
  arrow(vec(exitSplit.x, splitZ - 19), vec(0, -1, 0));
  arrow(at(exitEnd - 25, auxOffset), heading(exitEnd - 25));
  arrow(at(entryStart + 24, auxOffset), heading(entryStart + 24));
  // Merge the paint into one draw call without connecting its independent strips.
  if (markings.length) {
    // Degenerate rows between strips keep the shared buffer disconnected.
    const joined = [];
    for (const r of markings) {
      if (joined.length) joined.push([joined.at(-1)[1], joined.at(-1)[1]], [r[0][0], r[0][0]]);
      joined.push(...r);
    }
    strip(joined, paint, 'north-interchange-markings', 2);
  }

  const lanes = [
    { points: off, highwayIndex: Math.round(exitStart / length * n), entering: false },
    { points: on, highwayIndex: Math.round(entryEnd / length * n), entering: true },
  ];
  const minimap = [
    [[1170, cityZ], [1170, splitZ]],
    off.slice(0, -1).map(({ x, z }) => [x, z]),
    on.slice(1).map(({ x, z }) => [x, z]),
  ];
  const rowBounds = footprints.map((rows) => ({ rows,
    minX: Math.min(...rows.flat().map(p => p.x)), maxX: Math.max(...rows.flat().map(p => p.x)),
    minZ: Math.min(...rows.flat().map(p => p.z)), maxZ: Math.max(...rows.flat().map(p => p.z)),
  }));
  const cross2 = (a, b, x, z) => (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
  const tri = (a, b, c, x, z) => cross2(a, b, x, z) <= .0001 &&
    cross2(b, c, x, z) <= .0001 && cross2(c, a, x, z) <= .0001;
  function contains(x, z) {
    for (const { rows, minX, maxX, minZ, maxZ } of rowBounds) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      for (let i = 1; i < rows.length; i++) {
        const [a, b] = rows[i - 1], [c, d] = rows[i];
        if (tri(a, b, c, x, z) || tri(b, d, c, x, z)) return true;
      }
    }
    return false;
  }
  function distance(x, z) {
    if (contains(x, z)) return 0;
    let d = Infinity;
    for (const lane of lanes) for (const p of lane.points) {
      d = Math.min(d, (x - p.x) ** 2 + (z - p.z) ** 2);
    }
    return Math.sqrt(d);
  }

  const commute = new THREE.CurvePath();
  class HighwaySection extends THREE.Curve {
    constructor(a, b, lane) { super(); this.a = a; this.b = b; this.lane = lane; this.arcLengthDivisions = 900; }
    getPoint(t) {
      const s = THREE.MathUtils.lerp(this.a, this.b, t);
      return at(s, this.lane === null ? travelOffset : offset(s, this.lane));
    }
  }
  commute.add(new HighwaySection(exitStart, exitEnd, false));
  commute.add(exitBend);
  let prev = exitSplit;
  const corners = [vec(exitCity.x, 483.5), vec(1046.5, 483.5), vec(1046.5, 606.5), vec(entryCity.x, 606.5)];
  corners.forEach((corner, i) => {
    const before = corners[i - 1] ?? exitSplit, after = corners[i + 1] ?? entrySplit;
    const a = corner.clone().lerp(before, 9 / corner.distanceTo(before));
    const b = corner.clone().lerp(after, 9 / corner.distanceTo(after));
    commute.add(new THREE.LineCurve3(prev, a));
    commute.add(new THREE.QuadraticBezierCurve3(a, corner, b));
    prev = b;
  });
  commute.add(new THREE.LineCurve3(prev, entrySplit));
  commute.add(entryBend);
  commute.add(new HighwaySection(entryStart, entryEnd, true));
  commute.add(new HighwaySection(entryEnd, length + exitStart, null));
  const curveLengths = commute.getCurveLengths();
  const total = commute.getLength();
  // CurvePath.getPoint already uses distances; applying getPointAt again distorts its speed.
  commute.getPointAt = (t) => commute.getPoint(t);
  commute.getTangentAt = (t) => commute.getTangent(t);
  const speedAt = (t, max) => {
    const s = t * total;
    if (s < curveLengths[0]) return THREE.MathUtils.lerp(max, 14, smooth(s / curveLengths[0]));
    const rampStart = curveLengths.at(-3), rampEnd = curveLengths.at(-2);
    if (s < rampStart) return 14;
    if (s < rampEnd) return THREE.MathUtils.lerp(14, max, smooth((s - rampStart) / (rampEnd - rampStart)));
    return max;
  };
  const curbGaps = [[exitStart, exitEnd], [entryStart, entryEnd]]
    .map(range => range.map(s => Math.round(s / length * n)));
  const replacesCurb = i => curbGaps.some(([a, b]) => i >= a - 1 && i <= b);
  return { group, lanes, minimap, contains, distance, replacesCurb,
    traffic: { curve: commute, length: total, speedAt } };
}
