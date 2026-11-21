// Spatial index of the same centerline segments used to build the road ribbons.
export function buildRoadIndex(roads, cell = 32) {
  const cells = new Map();
  const segments = [];
  const decks = new Map();
  const key = (x, z) => `${x},${z}`;
  for (const road of roads) {
    for (let i = 1; i < road.samples.length; i++) {
      const a = road.samples[i - 1].pos, b = road.samples[i].pos;
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      if (l2 < 1e-8) continue;
      const r = road.samples[i - 1].w / 2 + 0.65;
      const s = { a, dx, dz, l2, r2: r * r, kind: road.kind, id: road.id };
      segments.push(s);
      if (road.deck) {
        const v = road.deck, k = (i - 1) * 6;
        const a = v.slice(k, k + 3), b = v.slice(k + 3, k + 6);
        const c = v.slice(k + 6, k + 9), d = v.slice(k + 9, k + 12);
        for (const tri of [[a, b, c], [b, d, c]]) {
          const xs = tri.map(p => p[0]), zs = tri.map(p => p[2]);
          for (let ix = Math.floor(Math.min(...xs) / cell); ix <= Math.floor(Math.max(...xs) / cell); ix++) {
            for (let iz = Math.floor(Math.min(...zs) / cell); iz <= Math.floor(Math.max(...zs) / cell); iz++) {
              const k = key(ix, iz);
              if (!decks.has(k)) decks.set(k, []);
              decks.get(k).push(tri);
            }
          }
        }
      }
      for (let x = Math.floor((Math.min(a.x, b.x) - r) / cell); x <= Math.floor((Math.max(a.x, b.x) + r) / cell); x++) {
        for (let z = Math.floor((Math.min(a.z, b.z) - r) / cell); z <= Math.floor((Math.max(a.z, b.z) + r) / cell); z++) {
          const k = key(x, z);
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(s);
        }
      }
    }
  }
  function distance2(s, x, z) {
    const vx = x - s.a.x, vz = z - s.a.z;
    const t = Math.max(0, Math.min(1, (vx * s.dx + vz * s.dz) / s.l2));
    return (vx - s.dx * t) ** 2 + (vz - s.dz * t) ** 2;
  }
  return {
    surfaceAt(x, z) {
      const list = cells.get(key(Math.floor(x / cell), Math.floor(z / cell)));
      if (!list) return null;
      let result = null;
      for (const s of list) {
        if (distance2(s, x, z) > s.r2) continue;
        if (s.kind === 'pave') return 'pave';
        result = s.kind;
      }
      return result;
    },
    deckAt(x, z) {
      const list = decks.get(key(Math.floor(x / cell), Math.floor(z / cell)));
      let height = null;
      for (const [a, b, c] of list ?? []) {
        const dx = b[0] - a[0], dz = b[2] - a[2], ex = c[0] - a[0], ez = c[2] - a[2];
        const det = dx * ez - dz * ex;
        if (Math.abs(det) < 1e-8) continue;
        const u = ((x - a[0]) * ez - (z - a[2]) * ex) / det;
        const v = (dx * (z - a[2]) - dz * (x - a[0])) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        const y = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
        height = height === null ? y : Math.max(height, y);
      }
      return height;
    },
    distance(x, z) {
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
      let best = Infinity;
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const list = cells.get(key(ix, iz));
        if (list) for (const s of list) best = Math.min(best, distance2(s, x, z));
      }
      if (best > cell * cell) for (const s of segments) best = Math.min(best, distance2(s, x, z));
      return Math.sqrt(best);
    },
  };
}

// Conservative AABB clearance for building footprints and roadside props.
export function roadOverlapsBox(samples, x, z, hw, hd, margin = 0) {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].pos, b = samples[i].pos;
    const r = samples[i - 1].w / 2 + margin;
    const dx = b.x - a.x, dz = b.z - a.z;
    let lo = 0, hi = 1;
    for (const [offset, half, delta] of [[a.x - x, hw + r, dx], [a.z - z, hd + r, dz]]) {
      if (Math.abs(delta) < 1e-8) {
        if (Math.abs(offset) > half) { lo = 2; break; }
        continue;
      }
      const u = (-half - offset) / delta, v = (half - offset) / delta;
      lo = Math.max(lo, Math.min(u, v));
      hi = Math.min(hi, Math.max(u, v));
    }
    if (lo <= hi) return true;
  }
  return false;
}

// Each entry is an independently reviewed at-grade junction, not a proximity rule.
export const ROAD_JUNCTIONS = [
  ['highway', 'eastConn', 1860, 360], ['highway', 'southConn', 806, 1015],
  ['highway', 'national', -615, 341], ['highway', 'mountainRoad', 690, -870],
  ['highway', 'westLake', 612, -862], ['highway', 'swLink', -320, -536],
  ['highway', 'country', -659, 51], ['highway', 'country', -619, -171],
  ['eastConn', 'city7', 1296, 350], ['southConn', 'city2', 1050, 616],
  ['lakeRoad', 'roundabout', 820, -400], ['lakeRoad', 'city1', 930, 612],
  ['lakeRoad', 'city5', 853, 90], ['lakeRoad', 'city6', 868, 220],
  ['lakeRoad', 'city7', 886, 350], ['lakeRoad', 'city8', 906, 480],
  ['lakeRoad', 'city9', 930, 610], ['lakeRoad', 'city14', 860, 155],
  ['lakeRoad', 'city15', 877, 285], ['lakeRoad', 'city16', 895, 415],
  ['lakeRoad', 'city17', 918, 545], ['roundabout', 'trail', 840, -420],
  ['roundabout', 'westLake', 810, -402], ['national', 'country', -722, 52],
  ['national', 'city0', 810, 350], ['national', 'city7', 810, 350],
  ['mountainRoad', 'summitRing', 369, -1390], ['swLink', 'country', -620, -560],
];
