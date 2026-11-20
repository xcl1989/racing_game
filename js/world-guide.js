import * as THREE from 'three';
import { boxBatch } from './scene-detail.js';

export const LAKE = { x: 660, z: -560, r: 136 };
export const FOOTHILL_LAKE = { x: -1500, z: -1900, r: 186 };
export const RIVER = { x: -900, z: 0, halfWidth: 34.4, halfLength: 1700 };

export function worldGuide({ MT, northInterchange, national, country, lakeRoad, westLakeRoad, mountainRoad }) {
  const nearest = (samples, x, z) => samples.reduce((a, b) =>
    Math.hypot(b.pos.x - x, b.pos.z - z) < Math.hypot(a.pos.x - x, a.pos.z - z) ? b : a);
  const entry = northInterchange.lanes.find(lane => lane.entering).points[0];
  const exit = northInterchange.lanes.find(lane => !lane.entering).points.at(-1);
  const rampX = (entry.x + exit.x) / 2;
  const rampZ = entry.z - 36;
  const point = (route, x, z) => nearest(route.samples, x, z).pos;
  return [
    { name: '霓虹城区', code: 'CITY', target: { x: 1050, z: 350 }, label: [1540, 535], color: '#77d9e8' },
    { name: '北环互通', code: 'NORTH LINK', target: { x: rampX, z: 610 }, label: [1120, 1210], color: '#f2c47b',
      sign: { x: rampX, z: rampZ, yaw: 0, side: -1 } },
    { name: '落霞河谷', code: 'RIVER VALLEY', target: point(country, -900, 62), label: [-1100, 170], color: '#f2c47b',
      route: country, approaches: [[-788, 55, 1], [-1020, 40, -1]] },
    { name: '镜湖环线', code: 'MIRROR LAKE', target: point(westLakeRoad, 810, -400), label: [724, -582], color: '#82d9bd',
      route: lakeRoad, approaches: [[836, -160, 1]] },
    { name: '纳尔山道', code: 'NARU PASS', target: mountainRoad.samples.at(-1).pos, label: [MT.x - 345, MT.z - 310], color: '#b9dcae',
      route: mountainRoad, approaches: [[645, -988, 1]] },
    { name: '环道训练场', code: 'CIRCUIT', target: null, label: [-90, -65], color: '#e5b0a0' },
    { name: '河谷国道', code: 'VALLEY ROAD', target: null, label: null, color: '#f2c47b',
      route: national, approaches: [[723, 354, 1], [-220, 450, 1]] },
  ].map(region => ({ ...region, station: region.route && region.approaches.map(([x, z, dir]) => {
    const { pos, tan, w } = nearest(region.route.samples, x, z);
    return { x: pos.x, z: pos.z, yaw: Math.atan2(tan.x * dir, tan.z * dir), side: -1, offset: w / 2 + 4.6 };
  }) }));
}

export function addWorldSigns(parent, guide, ground, isClear) {
  const group = new THREE.Group();
  group.name = 'world-wayfinding';
  const posts = [];
  for (const region of guide) for (const p of region.station || (region.sign ? [region.sign] : [])) {
    const offset = p.offset || 10.8;
    const yaw = p.yaw + Math.PI;
    const ax = Math.cos(p.yaw) * p.side, az = -Math.sin(p.yaw) * p.side;
    const corners = [-3.4, 0, 3.4];
    let x, z, found = false;
    for (const n of [0, 3, 6, 9]) {
      x = p.x + ax * (offset + n); z = p.z + az * (offset + n);
      if (corners.every(t => isClear(x + ax * t, z + az * t))) { found = true; break; }
    }
    if (!found) continue;
    const y = ground(x, z);
    if (y < -.3) continue;
    const h = 3.75;
    const c = document.createElement('canvas'); c.width = 512; c.height = 192;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#102732'; ctx.fillRect(0, 0, 512, 192);
    ctx.strokeStyle = region.color; ctx.lineWidth = 7; ctx.strokeRect(11, 11, 490, 170);
    ctx.fillStyle = '#eef5ee'; ctx.font = 'bold 62px sans-serif'; ctx.fillText(region.name, 34, 92);
    ctx.fillStyle = region.color; ctx.font = 'bold 28px monospace'; ctx.fillText(region.code, 39, 144);
    ctx.strokeStyle = region.color;
    ctx.beginPath(); ctx.moveTo(448, 106); ctx.lineTo(448, 58); ctx.moveTo(428, 79); ctx.lineTo(448, 58);
    ctx.lineTo(468, 79); ctx.stroke();
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 2.7), new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide }));
    plate.name = region.code;
    plate.position.set(x, y + h, z); plate.rotation.y = yaw;
    group.add(plate);
    for (const t of [-2.65, 2.65]) {
      const bx = x + ax * t, bz = z + az * t, by = ground(bx, bz);
      const top = y + h + .25;
      posts.push([bx, (by + top) / 2, bz, .18, top - by, .18]);
    }
  }
  boxBatch(group, 'sign-posts', new THREE.MeshStandardMaterial({ color: 0x555e5d, roughness: .82 }), posts);
  parent.add(group);
}
