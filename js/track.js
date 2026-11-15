// track.js — 大地图闭环赛道：样条曲线 → 路面几何 → 起点/检查点
import * as THREE from 'three';
import { makeAsphaltTextures, makeDirtTextures, makeCheckerTexture } from './textures.js';

export const HALF_WIDTH = 7;      // 路半宽（总宽 14m，双向车道）
export const GATE_COUNT = 10;     // 检查点数量（含起点）

// 赛道控制点（大约 900m 周长的环线，跨 ±400 区域）
const POINTS = [
  [0, 0], [150, -25], [285, -120], [300, -280], [180, -380],
  [0, -400], [-160, -340], [-300, -300], [-385, -160], [-320, 0],
  [-360, 160], [-240, 280], [-80, 325], [85, 280], [140, 140], [40, 55],
];

const SEG = 900; // 采样密度

export function buildTrack(scene) {
  const curve = new THREE.CatmullRomCurve3(
    POINTS.map((p) => new THREE.Vector3(p[0], 0, p[1])),
    true, 'catmullrom', 0.5
  );

  // ---- 采样点：位置 / 切线 / 侧向 ----
  const samples = [];
  let dist = 0;
  let prev = null;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const pos = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).setY(0).normalize();
    const side = new THREE.Vector3(tan.z, 0, -tan.x).normalize(); // 左侧
    if (prev) dist += pos.distanceTo(prev);
    samples.push({ pos, tan, side, d: dist });
    prev = pos;
  }
  const trackLength = curve.getLength();

  // ---- 路面 Ribbon 几何 ----
  const verts = [], uvs = [], idx = [];
  const uvScale = 6; // 每 6m 重复一次贴图
  for (let i = 0; i <= SEG; i++) {
    const s = samples[i];
    const v = s.d / uvScale;
    const L = s.pos.clone().addScaledVector(s.side, HALF_WIDTH);
    const R = s.pos.clone().addScaledVector(s.side, -HALF_WIDTH);
    verts.push(L.x, 0.02, L.z, R.x, 0.02, R.z);
    uvs.push(0, v, 1, v);
    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(idx);
  roadGeo.computeVertexNormals();
  const asphalt = makeAsphaltTextures();
  const road = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({
    map: asphalt.map,
    normalMap: asphalt.normal,
    normalScale: new THREE.Vector2(0.75, 0.75),
    roughnessMap: asphalt.roughness,
    roughness: 0.9,          // roughnessMap 乘数
    metalness: 0.04,
    envMapIntensity: 0.55,   // 沥青微反射（潮湿高光感）
  }));
  road.receiveShadow = true;
  scene.add(road);

  // ---- 土路肩（路面两侧的泥土过渡带）----
  const SH = 2.8; // 肩宽

  function buildShoulder(sign) {
    const vs = [], uvs = [], idx2 = [];
    for (let i = 0; i <= SEG; i++) {
      const s = samples[i];
      const v = s.d / 5;
      const A = s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 0.1));
      const B = s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + SH));
      vs.push(A.x, 0.012, A.z, B.x, 0.012, B.z);
      uvs.push(0, v, 1, v);
      if (i < SEG) {
        const a = i * 2;
        idx2.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(vs, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx2);
    g.computeVertexNormals();
    const dirt = makeDirtTextures(1);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: dirt.map, normalMap: dirt.normal,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 1, metalness: 0,
    }));
    m.receiveShadow = true;
    return m;
  }
  scene.add(buildShoulder(1), buildShoulder(-1));

  // ---- 起点：柱子 + 格子旗横幅 ----
  const s0 = samples[0];
  const postMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5, metalness: 0.3 });
  const postGeo = new THREE.CylinderGeometry(0.3, 0.3, 7, 8);
  for (const sgn of [1, -1]) {
    const p = s0.pos.clone().addScaledVector(s0.side, sgn * (HALF_WIDTH + 1));
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(p.x, 3.5, p.z);
    post.castShadow = true;
    scene.add(post);
  }
  const banner = new THREE.Mesh(
    new THREE.BoxGeometry(HALF_WIDTH * 2 + 2, 1.6, 0.3),
    new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 0.6 })
  );
  banner.position.set(s0.pos.x, 6.5, s0.pos.z);
  banner.rotation.y = Math.atan2(s0.tan.x, s0.tan.z);
  scene.add(banner);

  // ---- 检查点门柱（比赛模式显示）----
  const gatesGroup = new THREE.Group();
  const gateMat = new THREE.MeshStandardMaterial({
    color: 0x333333, emissive: 0xff8c1a, emissiveIntensity: 1.6, roughness: 0.4,
  });
  const gateGeo = new THREE.CylinderGeometry(0.22, 0.22, 3.2, 6);
  for (let k = 1; k < GATE_COUNT; k++) {
    const t = k / GATE_COUNT;
    const s = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).setY(0).normalize();
    const side = new THREE.Vector3(tan.z, 0, -tan.x);
    for (const sgn of [1, -1]) {
      const p = s.clone().addScaledVector(side, sgn * (HALF_WIDTH + 0.5));
      const pole = new THREE.Mesh(gateGeo, gateMat);
      pole.position.set(p.x, 1.6, p.z);
      gatesGroup.add(pole);
    }
  }
  gatesGroup.visible = false;
  scene.add(gatesGroup);

  // ---- 直线加速赛道（地图东南，760m 冲刺）----
  const strip = { ax: 520, az: 140, bx: 520, bz: -620, width: 14 };
  {
    const A = new THREE.Vector3(strip.ax, 0.02, strip.az);
    const dir = new THREE.Vector3(0, 0, -1);
    const side = new THREE.Vector3(dir.z, 0, -dir.x); // 左侧
    const hw = strip.width / 2;
    const L1 = A.clone().addScaledVector(side, hw);
    const R1 = A.clone().addScaledVector(side, -hw);
    const L2 = A.clone().addScaledVector(dir, 760).addScaledVector(side, hw);
    const R2 = A.clone().addScaledVector(dir, 760).addScaledVector(side, -hw);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [L1.x, 0.02, L1.z, R1.x, 0.02, R1.z, L2.x, 0.02, L2.z, R2.x, 0.02, R2.z], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 126, 1, 126], 2));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    g.computeVertexNormals();
    const stripRoad = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: (() => {
        const t = makeAsphaltTextures().map;
        t.repeat.set(1, 126);
        return t;
      })(),
      normalMap: (() => {
        const n = makeAsphaltTextures().normal;
        n.repeat.set(1, 126);
        return n;
      })(),
      roughnessMap: (() => {
        const r = makeAsphaltTextures().roughness;
        r.repeat.set(1, 126);
        return r;
      })(),
      roughness: 0.9, metalness: 0.04, envMapIntensity: 0.55,
    }));
    stripRoad.receiveShadow = true;
    scene.add(stripRoad);
    // 起/终点格子线
    const checkMat = new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 0.6 });
    for (const p of [A.clone(), A.clone().addScaledVector(dir, 758)]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(strip.width, 2.4), checkMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(p.x, 0.04, p.z);
      scene.add(line);
    }
  }

  // 点到直线加速赛段的距离（供场景生成避开 + 离路判定）
  function distToStrip(x, z) {
    const dx = strip.bx - strip.ax, dz = strip.bz - strip.az;
    const t = Math.max(0, Math.min(1, ((x - strip.ax) * dx + (z - strip.az) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - (strip.ax + dx * t), z - (strip.az + dz * t));
  }

  // ---- 最近样条查询（含提示加速：从上次索引附近找）----
  function nearestSample(pos, hint = -1) {
    let bi = 0, bd = Infinity;
    if (hint >= 0) {
      for (let o = -30; o <= 30; o++) {
        const i = (hint + o + SEG) % SEG;
        const d = samples[i].pos.distanceToSquared(pos);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bd < 400) return { i: bi, d: Math.sqrt(bd) }; // 提示命中
    }
    for (let i = 0; i < SEG; i++) {
      const d = samples[i].pos.distanceToSquared(pos);
      if (d < bd) { bd = d; bi = i; }
    }
    return { i: bi, d: Math.sqrt(bd) };
  }

  const startPos = samples[0].pos.clone();
  const startYaw = Math.atan2(samples[0].tan.x, samples[0].tan.z);

  return {
    curve, samples, SEG, length: trackLength,
    gatesGroup, startPos, startYaw,
    strip, distToStrip,
    nearestSample,
    // 判断是否冲出路面（环道或直线加速赛道）
    isOffroad(pos, hint) {
      const { i, d } = nearestSample(pos, hint);
      const offRoad = d > HALF_WIDTH + 0.8;
      const onStrip = distToStrip(pos.x, pos.z) <= strip.width / 2 + 0.6;
      return { off: offRoad && !onStrip, hint: i };
    },
  };
}
