import * as THREE from 'three';
import { roadOverlapsBox } from './road-network.js';
import { boxBatch } from './scene-detail.js';

const STREET = 1170;
const WINDOWS = [[490, 535], [555, 600]];
const ROAD_MARGIN = .50;
const NAME = 'p10-north-storefronts';
const PALETTE = { stone: 0x8b8174, plaster: 0xa69b89, frame: 0x464b46,
  glass: 0x3f5659, frosted: 0x778585, shop: 0x894e3b, workshop: 0x657368, lintel: 0x666762 };
const overlaps = (a, b, margin = 0) => Math.abs(a.x - b.x) <= a.hw + b.hw + margin &&
  Math.abs(a.z - b.z) <= a.hd + b.hd + margin;
const footprint = ([x, , z, w, , d]) => ({ x, z, hw: w / 2, hd: d / 2 });

function projectedBounds(objects) {
  const result = [], matrix = new THREE.Matrix4(), bounds = new THREE.Box3();
  const add = (source, transform) => {
    const { min, max } = bounds.copy(source).applyMatrix4(transform);
    const b = { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2,
      hw: (max.x - min.x) / 2, hd: (max.z - min.z) / 2 };
    if (overlaps(b, { x: STREET, z: 545, hw: 45, hd: 55 })) result.push(b);
  };
  for (const root of objects) root?.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, matrix);
        add(o.geometry.boundingBox, matrix.premultiply(o.matrixWorld));
      }
    } else add(o.geometry.boundingBox, o.matrixWorld);
  });
  return result;
}

function plan(anchor, kind) {
  const { wall, side, lo, hi, baseY } = anchor;
  const center = (lo + hi) / 2, span = hi - lo - 1.5;
  const shell = [], glazing = [];
  const add = (list, z, y, width, height, back, front, color) => list.push({
    box: [wall + side * (back + front) / 2, y + baseY, center + z, front - back, height, width], color,
  });
  const solid = (...args) => add(shell, ...args);
  const glass = (...args) => add(glazing, ...args);
  solid(0, 1.55, span, 3.08, .009, .038, PALETTE.plaster);
  const type = kind === 'shop' ? 0 : kind === 'workshop' ? 1 : 2;
  const width = type === 0 ? 2.20 : type === 1 ? 1.76 : 1.60;
  const pitch = width + .30, doorZ = type === 0 ? 2.44 : type === 1 ? -.80 : .40;
  for (const [from, to] of [[-span / 2 + .02, doorZ - .64], [doorZ + .64, span / 2 - .02]]) {
    solid((from + to) / 2, .30, to - from, .53, .039, .082, PALETTE.stone);
    solid((from + to) / 2, .582, to - from - .01, .031, .04, .095, PALETTE.lintel);
  }
  const windows = [];
  for (const dir of [-1, 1]) {
    const first = doorZ + dir * (.78 + width / 2);
    for (let z = first, i = 0; i < (type === 2 ? 1 : 2) && Math.abs(z) + width / 2 < span / 2 - .40; z += dir * pitch, i++) {
      windows.push(z);
    }
  }
  function opening(z, bottom, top, w, depth, sill = .09) {
    const h = top - bottom, y = bottom + h / 2, edge = .085;
    for (const dir of [-1, 1]) solid(z + dir * (w - edge) / 2, y, edge, h, .04, depth, PALETTE.frame);
    solid(z, bottom + sill / 2, w - 2 * edge, sill, .04, depth, PALETTE.frame);
    solid(z, top - edge / 2, w - 2 * edge, edge, .04, depth, PALETTE.frame);
    glass(z, y, w - 2 * edge + .012, h - .07, .044, depth - .051, PALETTE.glass);
  }
  for (const z of windows) {
    const low = type === 1 ? .56 : .59, top = type === 1 ? 2.53 : 2.57;
    const h = top - low;
    opening(z, low, top, width, .132);
    solid(z + (type === 0 ? .21 : 0), low + h / 2, .055, h - .16, .078, .111, PALETTE.frame);
    if (type === 1) {
      glass(z, low + .32, width - .172, .46, .080, .087, PALETTE.frosted);
      solid(z, low + .557, width - .164, .034, .084, .116, PALETTE.frame);
    }
  }
  const doorH = type === 1 ? 2.43 : 2.28;
  // Keep the doorway clear between the two runs of masonry skirting.
  opening(doorZ, .045, .045 + doorH, 1.27, .143, .17);
  solid(doorZ + side * .39, 1.05, .035, .26, .092, .136, PALETTE.stone);
  if (type === 2) {
    solid(0, 2.87, span - .19, .26, .04, .123, PALETTE.lintel);
    return { anchor, kind, shell, glazing };
  }
  const signWidth = type === 0 ? 7.05 : 3.65;
  const signZ = type === 0 ? -.42 : doorZ;
  const color = PALETTE[kind];
  solid(signZ, 2.857, signWidth, .52, .039, .154, color);
  solid(signZ, 2.623, signWidth + .06, .059, .042, .183, PALETTE.frame);
  const sign = { box: [wall + side * .158, baseY + 2.866, center + signZ, .002, .46, signWidth - .25],
    side, type };
  // A short cap is optional; the full facade still has to pass clearance checks.
  const canopy = { box: [wall + side * .352, baseY + 3.116, center + signZ, .63, .12, signWidth + .14], color };
  return { anchor, kind, shell, glazing, canopy, sign };
}

function removeRows(mesh, removed) {
  if (!mesh || !removed.size) return;
  const matrix = new THREE.Matrix4();
  for (let i = 0, next = 0, count = mesh.count; i < count; i++) {
    if (removed.has(i)) continue;
    mesh.getMatrixAt(i, matrix);
    mesh.setMatrixAt(next++, matrix);
  }
  mesh.count -= removed.size;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.boundingBox = mesh.boundingSphere = null;
}

function addSigns(parent, signs) {
  if (!signs.length) return;
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const pos = [], uv = [], idx = [];
  const bands = ['\u5317\u8857\u5546\u5e97', '\u5317\u8857\u5de5\u574a'];
  for (let type = 0; type < 2; type++) {
    const y = type * 64;
    ctx.fillStyle = '#' + PALETTE[type === 0 ? 'shop' : 'workshop'].toString(16);
    ctx.fillRect(0, y, 512, 64);
    ctx.fillStyle = '#d7cbb2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${type === 0 ? 38 : 42}px sans-serif`;
    // Use a narrower text stretch on the wide shop fascia.
    ctx.fillText(bands[type], 256, y + 33, type === 0 ? 126 : 242);
  }
  for (const { box: [x, y, z, , h, w], side, type } of signs) {
    const from = z + side * w / 2, to = z - side * w / 2;
    const offset = pos.length / 3;
    pos.push(x, y - h / 2, from, x, y - h / 2, to, x, y + h / 2, to, x, y + h / 2, from);
    const v0 = 1 - (64 * type + 60) / 128, v1 = 1 - (64 * type + 4) / 128;
    uv.push(.01, v0, .99, v0, .99, v1, .01, v1);
    idx.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  const lettering = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: .89 }));
  lettering.name = 'p10-storefront-lettering'; lettering.receiveShadow = true;
  parent.add(lettering);
}

export function addNorthStorefronts(parent, { storefrontAnchors, streetGlazing, cityStreets, roads,
  surfaceAt, bldColliders, corridor, obstacles, interchangePavement }) {
  if (parent.getObjectByName(NAME)) return;
  const protectedBoxes = projectedBounds(obstacles);
  const rampBounds = projectedBounds(interchangePavement);
  const streets = cityStreets.map(({ ax, az, bx, bz, width }) => ({
    x: (ax + bx) / 2, z: (az + bz) / 2,
    hw: ax === bx ? width / 2 : Math.abs(ax - bx) / 2,
    hd: az === bz ? width / 2 : Math.abs(az - bz) / 2,
  }));
  const ribbons = roads.filter(r => !r.id.startsWith('city'));
  const safe = (box, anchor, lo, hi) => {
    const b = footprint(box);
    if (b.z - b.hd < lo || b.z + b.hd > hi ||
        streets.some(st => overlaps(b, st, ROAD_MARGIN)) ||
        rampBounds.some(st => overlaps(b, st, ROAD_MARGIN)) ||
        protectedBoxes.some(obstacle => overlaps(b, obstacle)) ||
        bldColliders.some(other => other !== anchor.owner && overlaps(b, other)) ||
        ribbons.some(r => roadOverlapsBox(r.samples, b.x, b.z, b.hw, b.hd, ROAD_MARGIN))) return false;
    return [-b.hw, 0, b.hw].every(dx => [-b.hd, 0, b.hd].every(dz =>
      surfaceAt({ x: b.x + dx, z: b.z + dz }) === null));
  };
  const anchors = storefrontAnchors.map(anchor => ({ anchor,
    window: WINDOWS.findIndex(([lo, hi]) => anchor.lo + .65 >= lo && anchor.hi - .65 <= hi),
  })).filter(a => a.window >= 0).sort((a, b) => a.window - b.window ||
    Math.abs(a.anchor.wall - STREET) - Math.abs(b.anchor.wall - STREET) || a.anchor.lo - b.anchor.lo);
  function candidate({ anchor, window }, kind) {
    const facade = plan(anchor, kind);
    const [lo, hi] = WINDOWS[window];
    const clear = p => safe(p.box, anchor, lo, hi);
    if (![...facade.shell, ...facade.glazing, ...(facade.sign ? [facade.sign] : [])].every(clear)) return null;
    if (facade.canopy && clear(facade.canopy)) facade.shell.push(facade.canopy);
    return facade;
  }
  const first = anchors.filter(a => a.window === 0).map(a => candidate(a, 'shop')).filter(Boolean);
  const second = anchors.filter(a => a.window === 1).map(a => candidate(a, 'workshop')).filter(Boolean);
  const pairs = first.flatMap(a => second.filter(b => a.anchor.side !== b.anchor.side).map(b => [a, b]));
  // From the entry lane the shop is on the west; from the return lane the workshop is on the east.
  const pair = pairs.find(([a]) => a.anchor.side === 1) ?? pairs[0];
  const selected = pair ?? [first[0] ?? second[0]].filter(Boolean);
  const count = f => f.shell.length + f.glazing.length + (f.sign ? 1 : 0);
  let used = selected.reduce((n, f) => n + count(f), 0);
  for (const a of anchors) {
    if (selected.length >= 6) break;
    if (selected.some(f => f.anchor === a.anchor)) continue;
    const detail = candidate(a, 'secondary');
    if (detail && used + count(detail) <= 160) { selected.push(detail); used += count(detail); }
  }
  if (!selected.length || used > 160) return;

  // Three r160 generates UUIDs with Math.random(), including for purely visual
  // objects. Isolate constructor UUIDs from the game's procedural stream.
  const random = Math.random, word = new Uint32Array(1);
  let group;
  try {
    Math.random = () => globalThis.crypto.getRandomValues(word)[0] / 0x100000000;
    group = new THREE.Group(); group.name = NAME;
    for (const [key, roughness] of [['shell', .89], ['glazing', .49]]) {
      const rows = selected.flatMap(f => f[key]);
      const batch = boxBatch(group, `p10-storefront-${key}`,
        new THREE.MeshStandardMaterial({ roughness, metalness: key === 'glazing' ? .04 : 0 }), rows.map(r => r.box));
      const color = new THREE.Color();
      rows.forEach((row, i) => batch.setColorAt(i, color.setHex(row.color)));
      batch.instanceColor.needsUpdate = true;
    }
    addSigns(group, selected.flatMap(f => f.sign ? [f.sign] : []));
  } catch (error) {
    console.warn('[world] storefront prototype skipped', error);
    return;
  } finally {
    Math.random = random;
  }
  // Hide only the old rows owned by a successfully built and checked facade.
  const oldGlazing = new Set(), oldP5 = Object.fromEntries(Object.keys(corridor.batches).map(k => [k, new Set()]));
  group.userData.facades = selected.map(({ anchor, kind, shell, glazing, sign }) => {
    const boxes = [...shell, ...glazing].map(row => row.box);
    if (sign) boxes.push(sign.box);
    const lo = anchor.lo + .75, hi = anchor.hi - .75;
    for (const i of anchor.oldGlazing) oldGlazing.add(i);
    for (const bay of corridor.storefrontBays) {
      if (bay.owner !== anchor.owner || bay.hi < lo || bay.lo > hi) continue;
      for (const k of Object.keys(oldP5)) for (const i of bay[k]) oldP5[k].add(i);
    }
    return { kind, wall: anchor.wall, side: anchor.side, lo, hi, boxes };
  });
  removeRows(streetGlazing, oldGlazing);
  for (const [key, mesh] of Object.entries(corridor.batches)) removeRows(mesh, oldP5[key]);
  parent.add(group);
}
