import * as THREE from 'three';
import { createRoadMaterial } from './roads.js';
import { boxBatch, firCrown } from './scene-detail.js';

export function addShowcaseCorridor(parent, world) {
  const { highway, country, westLakeRoad, bldColliders, groundSampler, onAnyRoad } = world;
  const group = new THREE.Group();
  group.name = 'showcase-corridor';
  parent.add(group);
  const facade = [], awnings = [], glass = [], rails = [], posts = [], reflectors = [];
  const forage = [], trunks = [], pines = [];
  const mat = (color, roughness = .86) => new THREE.MeshStandardMaterial({ color, roughness });
  const roadPoint = (s, offset) => s.pos.clone().addScaledVector(s.side, offset);
  const bankY = p => groundSampler(p.x, p.z);
  const clear = (x, z, radius) => {
    for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius]) {
      if (onAnyRoad({ x: x + dx, z: z + dz })) return false;
    }
    return !bldColliders.some(b => Math.abs(x - b.x) < b.hw + radius && Math.abs(z - b.z) < b.hd + radius);
  };

  for (const { x, z, hw, hd } of bldColliders) {
    const axis = Math.sign(1170 - x);
    if (z < 405 || z > 615 || Math.abs(x - 1170) > 55 || !axis || hd < 6) continue;
    const wall = x + axis * hw;
    for (const offset of [-.51, .51]) {
      const bay = z + hd * offset;
      if (![bay - 2.5, bay, bay + 2.5].every(p => !onAnyRoad({ x: wall + axis * 2, z: p }))) continue;
      // Recessed dark surround, divided glass and a warm canopy edge.
      facade.push([wall + axis * .11, 1.53, bay, .22, 2.96, 4.9],
        [wall + axis * .27, 1.49, bay, .11, 2.72, .12]);
      for (const side of [-1, 1]) glass.push([wall + axis * .243, 1.49, bay + side * 1.19, .035, 2.64, 2.18]);
      awnings.push([wall + axis * .92, 3.04, bay, 1.82, .22, 5.1]);
      reflectors.push([wall + axis * 1.84, 3.04, bay, .045, .16, 5.05]);
    }
  }

  // Only the outer shoulder near the sample interchange; a graded vertex tint
  // and seeded edge wear avoid a hard uniform stripe next to the asphalt.
  const verts = [], cols = [], idx = [];
  let last = -1;
  const c = new THREE.Color();
  for (let i = 1; i < highway.samples.length - 1; i++) {
    const s = highway.samples[i];
    const { x, z } = s.pos;
    if (x < 910 || x > 1490 || z < 835) continue;
    const p = [roadPoint(s, 9.96), roadPoint(s, 10.95), roadPoint(s, 12.35 + .45 * Math.sin(i * 1.81))];
    if (p.some(v => groundSampler(v.x, v.z) > .025)) continue;
    const base = verts.length / 3;
    p.forEach((v, j) => {
      verts.push(v.x, Math.max(.026, bankY(v) + .012), v.z);
      c.setHex([0x353735, 0x56544c, 0x525446][j]).multiplyScalar(1 + Math.sin(i * 2.37 + j) * .14);
      cols.push(c.r, c.g, c.b);
    });
    if (last === i - 1) for (let j = base - 3; j < base - 1; j++) idx.push(j + 1, j, j + 3, j + 1, j + 3, j + 4);
    last = i;
    if (i % 6 !== 0) continue;
    const peg = roadPoint(s, 13.5);
    if (!clear(peg.x, peg.z, .3)) continue;
    posts.push([peg.x, bankY(peg) + .44, peg.z, .15, .88, .14]);
    reflectors.push([peg.x, bankY(peg) + .77, peg.z, .17, .13, .16]);
  }
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const shoulder = new THREE.Mesh(g, createRoadMaterial('dirt', { vertexColors: true }));
    shoulder.name = 'corridor-weathered-shoulder';
    shoulder.receiveShadow = true;
    group.add(shoulder);
  }

  for (const end of [-1, 1]) for (const side of [-1, 1]) {
    // Match the existing rail ends, then flare away and drop to the bank.
    const anchors = [[0, 0, 0], [4, .45, .16], [9, 1.04, .43], [15, 1.85, .80]]
      .map(([dx, dz, dy]) => new THREE.Vector3(-900 + end * (40 + dx), 2.18 - dy, 60 + side * (5.95 + dz)));
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1], b = anchors[i], m = a.clone().lerp(b, .5), delta = b.clone().sub(a);
      // boxBatch rotates about local Z before yaw; its long axis is local X.
      rails.push([m.x, m.y, m.z, delta.length(), .14, .19,
        Math.atan2(-delta.z, delta.x), Math.atan2(delta.y, Math.hypot(delta.x, delta.z))]);
    }
    for (const p of anchors.slice(1)) {
      const base = bankY(p), h = p.y - base;
      posts.push([p.x, base + h / 2, p.z, .18, h, .20]);
    }
    const tip = anchors.at(-1);
    reflectors.push([tip.x, tip.y + .12, tip.z, .26, .27, .23]);
  }
  // Short runs of stone at the bridge banks, not on the driveable deck.
  const bridge = country.samples.filter(s => s.pos.x < -822 && s.pos.x > -978);
  for (let i = 0; i < bridge.length; i++) for (const side of [-1, 1]) {
    const s = bridge[i];
    if (Math.abs(s.pos.x + 900) < 48) continue;
    const p = roadPoint(s, side * 7.35);
    if (!clear(p.x, p.z, .7)) continue;
    forage.push([p.x, bankY(p) + .12, p.z, 1.34, .31, .82, .9 * i]);
  }

  let row = 0;
  for (const s of westLakeRoad.samples.filter((_, i) => i % 3 === 0)) {
    const { x, z } = s.pos;
    if (x < 438 || x > 760 || z < -723 || z > -420) continue;
    const inland = Math.sign(s.side.x * (x - 660) + s.side.z * (z + 560)) || 1;
    const tree = roadPoint(s, inland * (12 + (row % 3) * 3.75));
    const low = roadPoint(s, -inland * (8.8 + (row % 2) * 3));
    if (bankY(tree) > -.3 && clear(tree.x, tree.z, 2.7)) {
      const h = 5.8 + row % 4 * .84, y = bankY(tree);
      trunks.push([tree.x, y + h * .22, tree.z, .23, h * .44, .23]);
      pines.push([tree.x, y + h * .58, tree.z, h, h * .85, h, row * 2.4, row % 3]);
    }
    if (bankY(low) > -.48 && clear(low.x, low.z, 1.2)) {
      const h = 1.35 + row % 4 * .20;
      pines.push([low.x, bankY(low) + .47 * h, low.z, h * 1.7, h, h * 1.35, row * 1.7, 3]);
    }
    row++;
  }
  boxBatch(group, 'corridor-shop-reveals', mat(0x413a32), facade);
  boxBatch(group, 'corridor-shop-glazing', mat(0x476575, .39), glass);
  boxBatch(group, 'corridor-shop-canopies', mat(0x813f31, .71), awnings);
  boxBatch(group, 'corridor-bridge-terminal-rails', mat(0x505b59, .64), rails);
  boxBatch(group, 'corridor-roadside-posts', mat(0x626a64), posts);
  boxBatch(group, 'corridor-reflectors', new THREE.MeshStandardMaterial({ color: 0xd7bb84, emissive: 0x685021, emissiveIntensity: .23 }), reflectors);
  boxBatch(group, 'corridor-bank-stones', mat(0x777064), forage);
  boxBatch(group, 'corridor-trees-trunks', mat(0x53422d), trunks);
  if (pines.length) {
    const mesh = new THREE.InstancedMesh(firCrown(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), pines.length);
    mesh.name = 'corridor-lake-vegetation';
    const pose = new THREE.Object3D();
    const colors = [0x365746, 0x3a604a, 0x506b42, 0x687a42];
    pines.forEach(([x, y, z, sx, sy, sz, yaw, tint], i) => {
      pose.position.set(x, y, z); pose.scale.set(sx * .43, sy, sz * .43); pose.rotation.y = yaw; pose.updateMatrix();
      mesh.setMatrixAt(i, pose.matrix); mesh.setColorAt(i, c.setHex(colors[tint]));
    });
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}
