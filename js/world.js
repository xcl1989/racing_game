// world.js — 开放大世界：高速公路 / 城市街区 / 乡道桥梁 / 河流 / 红绿灯 / NPC 路线 / 国道 / 盘山公路
import * as THREE from 'three';
import { createRoadMaterial } from './roads.js';
import { buildRoadIndex } from './road-network.js';
import { buildNorthInterchange } from './north-interchange.js';
import { addApproachMarkings, localPatrol, publicApproaches } from './road-transition.js';
import { addShowcaseCorridor } from './route-detail.js';
import { addNorthStorefronts } from './p10-storefronts.js';
import { boxBatch } from './scene-detail.js';
import { addSurfaceFinish, facadeFinish, terrainTint } from './world-surface-finish.js';
import { LAKE, FOOTHILL_LAKE, RIVER, worldGuide, addWorldSigns } from './world-guide.js';
import {
  makeAsphaltTextures, makeLaneTextures, makeHighwayTextures, makeJunctionTextures,
  makeGrassTexture, makeWaterNormal, makeDirtTextures,
  makeFacadeTexture, makeFacadeEmissive, makeGlassTexture,
} from './textures.js';
import { makeWaterMaterial, updateWater } from './water.js'; // v2.24 水面材质升级

// 通用道路带状网格构建：pts 含 y（桥面/山路抬升用）
// tex: 0=街道沥青 1=窄巷（无双黄线）2=高速四车道 3=土路（野径）4=无预绘标线的铺装
// matOpts.follow = 侧点贴地形偏移量（v2.14.3）：坡地路段路面左右两边各自采样地形高度，
// 避免"横向平直路面在坡上一侧悬空"（野径/湖西环路过湖盆坡带时的悬空路）
let terrainSampler = null; // buildWorld 烘焙地形后注入（ribbon 在模块顶层，作用域隔离）
// v2.33 缘石后处理：ribbon 先登记，全部道路建完后统一生成。
// 在与其他路面交叉处自动断开——旧版缘石横穿垂直路口的路面（白条压路，audit_08）
const kerbJobs = [];      // {id, cv, quadCenters, group}
const ribbonRegistry = []; // {id, samples, width, tex}
function ribbon(pts, closed, width, matOpts = {}, tex = 0) {
  const curve = pts instanceof THREE.CurvePath ? pts : new THREE.CatmullRomCurve3(pts, closed, matOpts.curveType ?? 'catmullrom', 0.5);
  // v2.28b: segLen 可调采样密度（默认 8m）。山地 follow 路必须细于地形网格（21m）——
  // 粗弦线在凸形路段会被地形三角刺穿（凸包差 >0.1m 抬升），细到 3m 弦线即面内精确细化
  const SEG = Math.max(64, Math.floor(curve.getLength() / (matOpts.segLen ?? 8)));
  const asphalt = tex === 1 ? makeLaneTextures()
    : tex === 2 ? makeHighwayTextures()
    : tex === 3 ? makeDirtTextures()
    : tex === 4 ? makeJunctionTextures()
    : makeAsphaltTextures();
  const verts = [], uvs = [], idx = [];
  const edgeL = [], edgeR = []; // v2.23: 左右路缘高度（缘石随横向坡度贴合）
  let dist = 0, prev = null;
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).setY(0).normalize();
    if (tan.lengthSq() < 0.01) tan.set(0, 0, 1);
    const side = up.clone().cross(tan).normalize();
    if (prev) dist += p.distanceTo(prev);
    prev = p;
    const L = p.clone().addScaledVector(side, width / 2);
    const R = p.clone().addScaledVector(side, -width / 2);
    let Ly = p.y, Ry = p.y;
    if (matOpts.follow !== undefined && terrainSampler) {
      // 侧点独立贴地：左右各自采样高度，路面横向随坡起伏不悬空
      Ly = Math.max(matOpts.minY ?? 0.03, terrainSampler(L.x, L.z) + matOpts.follow);
      Ry = Math.max(matOpts.minY ?? 0.03, terrainSampler(R.x, R.z) + matOpts.follow);
    }
    verts.push(L.x, Ly, L.z, R.x, Ry, R.z);
    edgeL.push(Ly); edgeR.push(Ry);
    const v = dist / 12; // v2.21.1: 1 v 单位 = 12m（标线物理比例：高速虚线画 3m/空 9m）
    uvs.push(0, v, 1, v);    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // v2.21：贴图工厂已单例化（make*Textures 内部缓存），直接共享实例不再 clone
  //（repeat 恒 (1,1)，旧 clone 是每路独立 GPU 纹理 —— 1024px 时代共享反而省 20 份显存）
  const { follow, minY, segLen, curveType, curb = true, ...surfaceOptions } = matOpts;
  const mat = createRoadMaterial(tex === 3 ? 'dirt' : 'asphalt', {
    map: asphalt.map, normalMap: asphalt.normal, roughnessMap: asphalt.roughness ?? null,
    normalScale: new THREE.Vector2(0.7, 0.7), ...surfaceOptions,
  });
  const roadMesh = new THREE.Mesh(g, mat);
  roadMesh.receiveShadow = true;
  const samples = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).setY(0).normalize();
    // v2.27 samples 附带路宽：导航引导线按车道偏移（nav.js 消费）
    samples.push({ pos: p, tan, side: up.clone().cross(tan).normalize(), w: width });
  }

  // v2.23 路缘石：沥青路两侧混凝土缘石（顶/内/外三面），道路立体感的最大单一元素。
  // 土路（tex=3）不装；高处路（盘山 44m）不装——远看是悬在山脊线上空的细亮条。
  // 截面 4 点：内底(路面)/内顶(+0.1)/外顶/外底(-0.06 撇入草地)
  const id0 = ribbonRegistry.length;
  ribbonRegistry.push({ id: id0, samples, width, tex });
  let mesh;
  let edgeMax = 0;
  for (let i = 0; i <= SEG; i++) {
    if (Number.isFinite(edgeL[i])) edgeMax = Math.max(edgeMax, edgeL[i]);
    if (Number.isFinite(edgeR[i])) edgeMax = Math.max(edgeMax, edgeR[i]);
  }
  if (curb && tex !== 3 && edgeMax <= 15) {
    const CH = 0.10, CW = 0.3;           // 缘石高/宽
    const cv = [], cidx = [];
    const quadCenters = [];              // 每段每侧缘石条带的中心（交叉处断开判定用）
    for (let sd = 0; sd < 2; sd++) {
      const sgn = sd === 0 ? 1 : -1;
      const eh = sd === 0 ? edgeL : edgeR;
      for (let i = 0; i <= SEG; i++) {
        const s = samples[i];
        const y = Number.isFinite(eh[i]) ? eh[i] : (i > 0 ? eh[i - 1] : 0.02); // NaN 防御：回退前截面
        const px = s.pos.x + s.side.x * sgn * (width / 2);
        const pz = s.pos.z + s.side.z * sgn * (width / 2);
        const ox = s.pos.x + s.side.x * sgn * (width / 2 + CW);
        const oz = s.pos.z + s.side.z * sgn * (width / 2 + CW);
        cv.push(
          px, y + 0.01, pz,       // 0 内底
          px, y + 0.01 + CH, pz,  // 1 内顶
          ox, y + 0.01 + CH, oz,  // 2 外顶
          ox, y - 0.06, oz        // 3 外底（微沉入草地）
        );
      }
      const base = sd * (SEG + 1) * 4;
      for (let i = 0; i < SEG; i++) {
        const a = base + i * 4, b = base + (i + 1) * 4;
        // 顶(a1,b1,b2) 内(a0,b0,b1) 外(b3,b2,a3) —— DoubleSide 不挑绕向
        cidx.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2);
        cidx.push(a, b, b + 1, a, b + 1, a + 1);
        cidx.push(b + 3, b + 2, a + 3, a + 3, b + 2, a + 2);
        // 条带中心（路口断开判定用）
        const s0 = samples[i], s1 = samples[i + 1];
        quadCenters.push({
          x: (s0.pos.x + s1.pos.x) / 2 + s0.side.x * sgn * (width / 2 + CW / 2),
          z: (s0.pos.z + s1.pos.z) / 2 + s0.side.z * sgn * (width / 2 + CW / 2),
        });
      }
    }
    // v2.33 缘石网格延后生成：kerbJobs 登记，buildWorld 末尾 attachCurbs() 统一挂接
    //（交叉路口与其他路面重叠的条带会被剔除，白条不再横穿垂直路面）
    kerbJobs.push({ id: id0, cv, quadCenters, group: mesh = new THREE.Group() });
    mesh.add(roadMesh);
  } else {
    mesh = roadMesh;
  }
  return { mesh, curve, samples, closed, length: curve.getLength(), deck: verts };
}

// v2.33 缘石统一挂接：全部路建完后执行。与其他路面交叉的缘石条带自动剔除——
// （每条条带中心到其他路样本的距离 < 其他路半宽+1.2m 即视为交叉，白条不再压路面）
function attachCurbs(skip = () => false) {
  if (!kerbJobs.length) return;
  const CELL = 25;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const r of ribbonRegistry) {
    for (let i = 0; i < r.samples.length; i += 2) { // 抽样 1/2 提速（交叉判定精度 8~12m 足够）
      const s = r.samples[i].pos;
      const k = key(s.x, s.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id: r.id, x: s.x, z: s.z, w: r.width });
    }
  }
  const nearOther = (id, x, z) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(`${cx + dx},${cz + dz}`);
      if (!arr) continue;
      for (const p of arr) {
        if (p.id === id) continue;
        const th = p.w / 2 + 1.6;
        const ddx = p.x - x, ddz = p.z - z;
        if (ddx * ddx + ddz * ddz < th * th) return true;
      }
    }
    return false;
  };
  const curbMat = createRoadMaterial('concrete', {
    color: 0xa6a9ad, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
  let kept = 0, cut = 0;
  for (const job of kerbJobs) {
    const keepIdx = [];
    job.quadCenters.forEach((c, qi) => {
      if (skip(job.id, qi) || nearOther(job.id, c.x, c.z)) { cut++; return; }
      keepIdx.push(qi);
      kept++;
    });
    if (!keepIdx.length) continue;
    // 重建索引：仅保留未剔除条带（每条带 = 3 组三角 × 顶点基 q*4）
    const cidx = [];
    for (const qi of keepIdx) {
      const a = qi * 4, b = a + 4;
      cidx.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2);
      cidx.push(a, b, b + 1, a, b + 1, a + 1);
      cidx.push(b + 3, b + 2, a + 3, a + 3, b + 2, a + 2);
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(job.cv, 3));
    cg.setIndex(cidx);
    cg.computeVertexNormals();
    const curb = new THREE.Mesh(cg, curbMat);
    curb.receiveShadow = true;
    curb.castShadow = true;
    job.group.add(curb);
  }
  kerbJobs.length = 0;
  console.log(`[world] 缘石条带 ${kept} 段保留 / ${cut} 段路口断开`);
}

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);
  kerbJobs.length = 0;    // v2.33 缘石后处理作业重置（可重复构建）
  ribbonRegistry.length = 0;
  const beaconBlinks = [];                    // 地标塔顶警示灯

  // ---- 高速公路：外环大 Oval（中心 600,150，长轴 1250 / 短轴 950）----
  // ⚠️ 抬高 2cm：与草地大圆盘(y=0)共面会全程 Z-fighting 闪烁
  const hPts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    hPts.push(new THREE.Vector3(
      600 + Math.cos(a) * 1250 + Math.sin(a * 3) * 90,
      0.02,
      150 + Math.sin(a) * 950 + Math.cos(a * 2) * 70
    ));
  }
  const highway = ribbon(hPts, true, 20, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, 2); // 四车道贴图
  group.add(highway.mesh);

  // ---- 城市街区路网（中心 1050,350）----
  // ⚠️ 路面高度分层错开防 Z-fighting；街道端点收齐成规矩 T 形/十字路口：
  //    纵街 z 跨 84..616（与横街 z=90/610 的远边缘齐平），横街 x 跨 804..1296
  //    —— 旧版两端多伸出 60m 直插草地，形成"断头路"
  const cityStreets = [];
  const signalJunctions = [[1050, 220], [1050, 480], [930, 350], [1170, 350]];
  const xs = [810, 930, 1050, 1170, 1290];
  const zs = [90, 220, 350, 480, 610];
  const Y_STREET = 0.012, Y_AVE = 0.026;
  for (const sx of xs) {
    const r = ribbon(
      [new THREE.Vector3(sx, Y_STREET, zs[0] - 6), new THREE.Vector3(sx, Y_STREET, zs[4] + 6)],
      false, 12, { roughness: 0.92, curb: false }
    );
    group.add(r.mesh);
    cityStreets.push({ ax: sx, az: zs[0] - 6, bx: sx, bz: zs[4] + 6, width: 12 });
  }
  for (const sz of zs) {
    const r = ribbon(
      [new THREE.Vector3(xs[0] - 6, Y_AVE, sz), new THREE.Vector3(xs[4] + 6, Y_AVE, sz)],
      false, 12, { roughness: 0.92, curb: false }
    );
    group.add(r.mesh);
    cityStreets.push({ ax: xs[0] - 6, az: sz, bx: xs[4] + 6, bz: sz, width: 12 });
  }

  // ---- 次级巷道：主街网格正中间穿插（路网加密，交叉仍是规矩的十字/T 形）----
  // ⚠️ 高度 0.018：介于纵街(0.012)/横街(0.026)之间，重叠区高差 ≥6mm 防远距 Z-fighting
  const Y_LANE = 0.018;
  const laneXs = [870, 990, 1110, 1230]; // 主街间距 120 的中点
  const laneZs = [155, 285, 415, 545];   // 主街间距 130 的中点
  for (const sx of laneXs) {
    const r = ribbon(
      [new THREE.Vector3(sx, Y_LANE, zs[0] - 6), new THREE.Vector3(sx, Y_LANE, zs[4] + 6)],
      false, 9, { roughness: 0.95, curb: false }, 1
    );
    group.add(r.mesh);
    cityStreets.push({ ax: sx, az: zs[0] - 6, bx: sx, bz: zs[4] + 6, width: 9 });
  }
  for (const sz of laneZs) {
    const r = ribbon(
      [new THREE.Vector3(xs[0] - 6, Y_LANE, sz), new THREE.Vector3(xs[4] + 6, Y_LANE, sz)],
      false, 9, { roughness: 0.95, curb: false }, 1
    );
    group.add(r.mesh);
    cityStreets.push({ ax: xs[0] - 6, az: sz, bx: xs[4] + 6, bz: sz, width: 9 });
  }

  // 城市行驶路线（NPC 环线）：只保留曲线供车流使用，不铺实体路面
  // —— 旧版沿街再铺一条 2.6cm 高的路，与街道长距离平行共面会闪
  const Y_ROUTE = 0.03;
  const corners = [[930,90],[1170,90],[1170,480],[930,480]]
    .map(([x,z]) => new THREE.Vector3(x,Y_ROUTE,z));
  const approach = (corner, neighbor) => corner.clone().lerp(neighbor, 11 / corner.distanceTo(neighbor));
  const trafficCurve = new THREE.CurvePath();
  for (let i = 0; i < corners.length; i++) {
    const before = corners[(i + 3) % 4], corner = corners[i], after = corners[(i + 1) % 4];
    trafficCurve.add(new THREE.LineCurve3(approach(before, corner), approach(corner, before)));
    trafficCurve.add(new THREE.QuadraticBezierCurve3(approach(corner, before), corner, approach(corner, after)));
  }
  trafficCurve.getPointAt = (t) => trafficCurve.getPoint(t);
  trafficCurve.getTangentAt = (t) => trafficCurve.getTangent(t);
  const cityRoute = { curve: trafficCurve, closed: true, length: trafficCurve.getLength() };

  function nearestCurvePoint(curve, tx, tz, filter) {
    let bp = null, bd = Infinity;
    for (let i = 0; i <= 400; i++) {
      const p = curve.getPointAt(i / 400);
      if (filter && !filter(p)) continue;
      const d = (p.x - tx) ** 2 + (p.z - tz) ** 2;
      if (d < bd) { bd = d; bp = p; }
    }
    return bp;
  }
  const approaches = publicApproaches(highway, { eastX: xs.at(-1), westX: xs[0], outerZ: zs.at(-1), lakeZ: zs[0] });
  const makeApproach = (curve, width, roughness) => ribbon(curve, false, width, { roughness, segLen: 3.0, curb: false }, 4);
  const eastConnRoad = makeApproach(approaches.east.curve, approaches.east.width, .9);
  const southConnRoad = makeApproach(approaches.belt.curve, approaches.belt.width, .9);
  const lakeRoad = makeApproach(approaches.lake, 9, .96);
  group.add(eastConnRoad.mesh, southConnRoad.mesh, lakeRoad.mesh);
  addApproachMarkings(group, [
    { route: eastConnRoad, endGap: 10.8, stop: true },
    { route: southConnRoad, endGap: 10.8, stop: true },
    { route: lakeRoad, endGap: 8.5, stop: false },
  ]);
  const approachJunctions = [
    ...[['eastConn', approaches.east], ['southConn', approaches.belt]].map(([id, link]) =>
      ['highway', id, link.junction.x, link.junction.z]),
    ['lakeRoad', 'city0', xs[0], zs[0] - 5.7], ['lakeRoad', 'city5', xs[0], zs[0]],
  ];
  const approachTraffic = {
    east: localPatrol('eastConn', eastConnRoad, 22, 35),
    belt: localPatrol('southConn', southConnRoad, 22, 39),
    lake: localPatrol('lakeRoad', lakeRoad, 24, 26),
  };
  const northInterchange = buildNorthInterchange(highway, zs[4]);
  group.add(northInterchange.group);

  // 环岛：闭合圆环（高于接入路 12mm 防共面闪烁）
  const roundPts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    roundPts.push(new THREE.Vector3(
      820 + Math.cos(a) * 20, 0.032,
      -420 + Math.sin(a) * 20
    ));
  }
  const roundabout = ribbon(roundPts, true, 8, { color: 0x9a9184, roughness: 1 });
  group.add(roundabout.mesh);

  // ---- 地标电视塔（城市东北天际线，观测舱 + 天线）----
  {
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.5, metalness: 0.35 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 5.5, 96, 12), towerMat);
    shaft.position.set(1350, 48, 60);
    shaft.castShadow = true;
    group.add(shaft);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 6.5, 9, 14), towerMat);
    pod.position.set(1350, 101, 60);
    pod.castShadow = true;
    group.add(pod);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 1.2, 14),
      new THREE.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.4, metalness: 0.5 }));
    deck.position.set(1350, 106.5, 60);
    group.add(deck);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.6, 34, 6), towerMat);
    antenna.position.set(1350, 124, 60);
    group.add(antenna);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2020, emissiveIntensity: 1.8 }));
    beacon.position.set(1350, 141.5, 60);
    group.add(beacon);
    const beaconBlink = { mesh: beacon };
    beaconBlinks.push(beaconBlink);
  }

  // ---- 国道：城市西出口 → 绕主赛道北侧 → 西行走廊 → 接入乡道闭环 ----
  // 让 城市↔乡道（含跨河桥）↔高速 全部连通，打破"各自为政"的割裂感
  // ⚠️ 走高速西侧走廊（x -700~-722），距高速西端 (-650,220) 最近 ~45m 不搭接
  const natPts = [
    new THREE.Vector3(810, 0.032, 350),   // 城市西出口：压横街(z=350)下 6mm
    new THREE.Vector3(640, 0.032, 356),
    new THREE.Vector3(430, 0.032, 398),
    new THREE.Vector3(180, 0.032, 448),
    new THREE.Vector3(-90, 0.032, 462),
    new THREE.Vector3(-330, 0.032, 438),
    new THREE.Vector3(-540, 0.032, 384),
    // v2.33 垂直穿越高速：旧版 (-540,384)→(-660,300) 与高速切向夹角仅 32°，近平行重叠 1.8m。
    // 高速在该处切向 ≈ (-0.39,-0.92)（南北向）→ 垂直穿越方向 = (-0.92,0.39)（东西向），
    // 穿越点 P=(-615,341)，前后各 22m 垂直进出。
    new THREE.Vector3(-594.8, 0.032, 332.4),
    new THREE.Vector3(-615, 0.032, 341),
    new THREE.Vector3(-635.2, 0.032, 349.6),
    new THREE.Vector3(-680, 0.032, 300),
    new THREE.Vector3(-710, 0.032, 180),
    new THREE.Vector3(-720, 0.032, 90),
    new THREE.Vector3(-722, 0.032, 52),   // 终点扎进乡道路面（乡道中心线 z≈52）
  ];
  const national = ribbon(natPts, false, 12, { roughness: 0.88 });
  group.add(national.mesh);

  // ---- 程序化山体（北海道纳尔）+ 盘山公路 + 山顶环岛 ----
  // 地形 = 解析高度场：terrainH 同时供路面取样、车物理 heightAt、山体网格、植被贴地
  // 山顶压平 44m 半径平台放环岛；外缘 90m 羽化到 0 与草地无缝衔接
  const MT = { x: 350, z: -1380, H: 72, SIG: 300, R: 520 };
  function mountainH(x, z) {
    const d = Math.hypot(x - MT.x, z - MT.z);
    if (d > MT.R) return 0;
    let fade = Math.min(1, (MT.R - d) / 90);
    fade = fade * fade * (3 - 2 * fade);
    let h = MT.H * Math.exp(-((d / MT.SIG) ** 2)) * fade;
    if (d < 64) { // 山顶平台：环岛区域压平（≈70.5m），44→64 平滑过渡
      const plat = MT.H * Math.exp(-((44 / MT.SIG) ** 2));
      let k = Math.min(1, Math.max(0, (64 - d) / 20));
      k = k * k * (3 - 2 * k);
      h = plat * k + h * (1 - k);
    }
    return h;
  }
  // 水文下切（v2.12）：河道/湖盆 = 负高度，让水面真正低于地面
  // 剖面：inner 内全深 → inner..outer smoothstep 回升到 0（自然斜坡两岸）
  function cutBand(adx, inner, outer, depth) { // 河道：按 |x-河心|
    if (adx > outer) return 0;
    if (adx < inner) return -depth;
    const t = (adx - inner) / (outer - inner);
    return -depth * (1 - t * t * (3 - 2 * t));
  }
  function cutRadial(x, z, cx, cz, inner, outer, depth) { // 湖盆：按距湖心半径
    const d = Math.hypot(x - cx, z - cz);
    if (d > outer) return 0;
    if (d < inner) return -depth;
    const t = (d - inner) / (outer - inner);
    return -depth * (1 - t * t * (3 - 2 * t));
  }
  // 完整地形：山体 + 河道 + 湖盆（scenery 地面网格与车物理共用）
  function terrainH(x, z) {
    let h = mountainH(x, z);
    // 河道（纵贯 x=-900，z ±1700 端部渐隐成旱沟尾；坡度收紧让下切读得出来）
    const zf = Math.max(0, Math.min(1, (RIVER.halfLength - Math.abs(z)) / 120));
    h += cutBand(Math.abs(x - RIVER.x), 20, 60, 2.2) * zf;
    // 湖1（湖东野径贴岸：盆缘 132-152 缓坡——坡带必须远宽于 43m 地面网格间距，否则插值岸坡错位）
    h += cutRadial(x, z, LAKE.x, LAKE.z, 132, 152, 1.7);
    // 湖2（山脚湖）
    h += cutRadial(x, z, FOOTHILL_LAKE.x, FOOTHILL_LAKE.z, 176, 215, 1.8);
    return h;
  }

  // ---- v2.12.2 物理/视觉同源烘焙 ----
  // 渲染地面是 5200 尺寸 120x120 位移网格（顶点间距 43.3m，三角形插值），
  // 解析 terrainH 的 10-18m 陡岸坡在网格上采不到 → 车按解析高度沉进"视觉草地"（草地落水 bug）。
  // 解法：把 terrainH 烘到同一网格。
  // ---- v2.28 可视面同源采样（盘山路修复的根） ----
  // 旧版两层偏差叠加导致"路被山面埋没 + 车陷进地里"（用户实机报告）：
  //   ① heightAt 双线性插值 ≠ 5200 平面的三角插值（反对角线 a-b-d / b-c-d）→ 坡地差 ±0.2m
  //   ② 山体网格直接用解析 terrainH，与烘焙场最多差 ~0.5m → 山脚尾段草地平面反超山面（绿平面切山），
  //      山腰段山面反超烘焙场 → 盘山路被埋、车陷半轮
  // 统一原则：物理高度 = 渲染面高度。samplePlane（5200 平面精确高度）/ sampleMountain（21m 山面
  // 网格精确高度，含边缘 150m 渐隐微抬防共面）；ribbon follow 与 heightAt 全部消费这两支。
  const G_SEG = 120, G_SIZE = 5200, G_HALF = G_SIZE / 2;
  const G_STEP = G_SIZE / G_SEG;
  const terrainGrid = new Float32Array((G_SEG + 1) * (G_SEG + 1));
  for (let j = 0; j <= G_SEG; j++) {
    for (let i = 0; i <= G_SEG; i++) {
      terrainGrid[j * (G_SEG + 1) + i] = terrainH(-G_HALF + i * G_STEP, -G_HALF + j * G_STEP);
    }
  }
  function sampleTerrain(x, z) { // 双线性插值（越界钳到边缘）——保留供 tests/植被用，物理不再直接消费
    const fx = Math.min(G_SEG - 1e-4, Math.max(0, (x + G_HALF) / G_STEP));
    const fz = Math.min(G_SEG - 1e-4, Math.max(0, (z + G_HALF) / G_STEP));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const S = G_SEG + 1;
    const h00 = terrainGrid[j * S + i], h10 = terrainGrid[j * S + i + 1];
    const h01 = terrainGrid[(j + 1) * S + i], h11 = terrainGrid[(j + 1) * S + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  // 5200 地面网格的三角插值高度 = 渲染草地面的真实高度（反对角线，与 PlaneGeometry 一致）
  function samplePlane(x, z) {
    const fx = Math.min(G_SEG - 1e-4, Math.max(0, (x + G_HALF) / G_STEP));
    const fz = Math.min(G_SEG - 1e-4, Math.max(0, (z + G_HALF) / G_STEP));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const S = G_SEG + 1;
    const a = terrainGrid[j * S + i],        // (i,j)
      b = terrainGrid[(j + 1) * S + i],      // (i,j+1)
      c = terrainGrid[(j + 1) * S + i + 1],  // (i+1,j+1)
      d = terrainGrid[j * S + i + 1];        // (i+1,j)
    if (tx + tz <= 1) return a + (d - a) * tx + (b - a) * tz;
    const u = 1 - tx, v = 1 - tz;
    return c + (b - c) * u + (d - c) * v;
  }
  // 山体可视网格：21m 顶点 = samplePlane + mtnLift（方框边缘 150m 渐隐到 0，与草地平面无缝）
  const M_SEG = 52, M_HALF = 540, M_STEP = (M_HALF * 2) / M_SEG;
  function mtnLift(x, z) {
    const ex = Math.min(x - (MT.x - M_HALF), (MT.x + M_HALF) - x);
    const ez = Math.min(z - (MT.z - M_HALF), (MT.z + M_HALF) - z);
    const t = Math.min(1, Math.max(0, Math.min(ex, ez) / 150));
    return 0.05 * t * t * (3 - 2 * t);
  }
  const mGrid = new Float32Array((M_SEG + 1) * (M_SEG + 1));
  for (let j = 0; j <= M_SEG; j++) {
    for (let i = 0; i <= M_SEG; i++) {
      const x = MT.x - M_HALF + i * M_STEP, z = MT.z - M_HALF + j * M_STEP;
      mGrid[j * (M_SEG + 1) + i] = samplePlane(x, z) + mtnLift(x, z);
    }
  }
  function sampleMountain(x, z) { // 山体网格的三角插值高度 = 渲染山面的真实高度
    if (Math.abs(x - MT.x) >= M_HALF || Math.abs(z - MT.z) >= M_HALF) return samplePlane(x, z);
    const fx = Math.min(M_SEG - 1e-4, Math.max(0, (x - (MT.x - M_HALF)) / M_STEP));
    const fz = Math.min(M_SEG - 1e-4, Math.max(0, (z - (MT.z - M_HALF)) / M_STEP));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const S = M_SEG + 1;
    const a = mGrid[j * S + i], b = mGrid[(j + 1) * S + i],
      c = mGrid[(j + 1) * S + i + 1], d = mGrid[j * S + i + 1];
    if (tx + tz <= 1) return a + (d - a) * tx + (b - a) * tz;
    const u = 1 - tx, v = 1 - tz;
    return c + (b - c) * u + (d - c) * v;
  }
  const inMtnSq = (x, z) => Math.abs(x - MT.x) < M_HALF && Math.abs(z - MT.z) < M_HALF;
  function groundSampler(x, z) { // 可视地面统一入口：山框内=山面，框外=草地平面
    return inMtnSq(x, z) ? sampleMountain(x, z) : samplePlane(x, z);
  }
  terrainSampler = groundSampler; // 烘焙完成后向模块级 ribbon 注入采样器（follow 贴地路贴可视面）
  {
    // 山体网格渲染：顶点直接吃 mGrid（与 sampleMountain/物理严格一致），反对角线三角化
    const verts = [], cols = [], uvs = [], idx = [];
    const tint = new THREE.Color();
    for (let j = 0; j <= M_SEG; j++) {
      for (let i = 0; i <= M_SEG; i++) {
        const x = MT.x - M_HALF + i * M_STEP, z = MT.z - M_HALF + j * M_STEP;
        const h = mGrid[j * (M_SEG + 1) + i];
        verts.push(x, h, z);
        const slope = Math.hypot(samplePlane(x+22,z)-samplePlane(x-22,z), samplePlane(x,z+22)-samplePlane(x,z-22)) / 44;
        terrainTint(x,z,h,slope,tint).toArray(cols,cols.length);
        // Match the plain's world scale without changing the mountain height grid.
        uvs.push((x + G_HALF) / G_SIZE, 1 - (z + G_HALF) / G_SIZE);
      }
    }
    const W = M_SEG + 1;
    for (let j = 0; j < M_SEG; j++) {
      for (let i = 0; i < M_SEG; i++) {
        const a = j * W + i, b = a + 1, c2 = a + W, d2 = c2 + 1;
        idx.push(a, c2, b, b, c2, d2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mtMesh = new THREE.Mesh(g, addSurfaceFinish(new THREE.MeshStandardMaterial({
      map: makeGrassTexture(170), vertexColors: true, roughness: 1, metalness: 0,
    }), 'terrain'));
    mtMesh.name = 'drivable-mountain';
    mtMesh.receiveShadow = true;
    group.add(mtMesh);
  }
  // 盘山公路：高速北段接入 → 螺旋上山（θ 0.84→5.84，r 400→20）→ 扎进山顶环岛
  // v2.28: follow=0.1 —— 路缘左右各自贴可视山面（groundSampler）+0.1，横向随坡起伏不悬空不埋边；
  // 山面在方框内 = 草地平面 + mtnLift(≤5cm)，路面恒高于山面 5cm
  const mRoadPts = [new THREE.Vector3(690, 0.032, -870)];
  for (let k = 1; k <= 4; k++) { // 引道：y 取 max(0.032, 可视面+0.1)，平滑过渡上山
    const t = k / 5;
    const x = 690 + (618 - 690) * t, z = -870 + (-1083 + 870) * t;
    mRoadPts.push(new THREE.Vector3(x, Math.max(0.032, groundSampler(x, z) + 0.1), z));
  }
  for (let k = 0; k <= 46; k++) {
    const t = k / 46;
    const th = 0.84 + t * 5.0;
    const r = 400 - t * 380;
    const x = MT.x + Math.cos(th) * r, z = MT.z + Math.sin(th) * r;
    mRoadPts.push(new THREE.Vector3(x, groundSampler(x, z) + 0.1, z));
  }
  const mountainRoad = ribbon(mRoadPts, false, 9, { roughness: 0.95, follow: 0.1, segLen: 3 });
  group.add(mountainRoad.mesh);
  // 山顶环岛（v2.28: follow=0.2 —— 高于盘山路 0.1 防共面；山顶平台已压平 → 全环等高）
  const summitPts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = MT.x + Math.cos(a) * 22, z = MT.z + Math.sin(a) * 22;
    summitPts.push(new THREE.Vector3(x, groundSampler(x, z) + 0.2, z));
  }
  const summitRing = ribbon(summitPts, true, 9, { roughness: 0.95, follow: 0.2 });
  group.add(summitRing.mesh);

  // ---- 乡间小道：西部闭环（垂直跨河的正经桥）----
  // ⚠️ 布局原则：
  //   1. 全程在赛道西侧外围（最近点距赛道 ≥ 175m），不发卡弯、不压赛道
  //      —— 旧版起点压赛道造成 Z-fighting，抬高又成"3cm 高架"
  //   2. 桥沿 X 轴垂直跨河：引道加密集过渡点压制 CatmullRom 过冲
  //      —— 旧版 4 点悬空过桥被样条织成 S 形"水上漂"
  const Y_COUNTRY = 0.02;
  const RIVER_X = RIVER.x;
  const cPts = [
    new THREE.Vector3(-560, Y_COUNTRY, 30),    // 东引道起点
    new THREE.Vector3(-700, Y_COUNTRY, 48),
    new THREE.Vector3(-800, 0.35, 56),         // 缓爬坡
    new THREE.Vector3(-860, 1.2, 60),          // 桥东端
    new THREE.Vector3(-900, 1.2, 62),          // 桥中
    new THREE.Vector3(-940, 1.2, 60),          // 桥西端
    new THREE.Vector3(-1000, 0.35, 54),        // 缓下坡
    new THREE.Vector3(-1100, Y_COUNTRY, 0),
    new THREE.Vector3(-1250, Y_COUNTRY, -120),
    new THREE.Vector3(-1180, Y_COUNTRY, -620),
    new THREE.Vector3(-760, Y_COUNTRY, -820),
    new THREE.Vector3(-620, Y_COUNTRY, -560),
    new THREE.Vector3(-640, Y_COUNTRY, -260),  // 闭合回东引道，弯道半径宽
  ];
  const country = ribbon(cPts, true, 8, { color: 0x9a9184, roughness: 1 }, 3); // 乡道：真·颠簸土路
  group.add(country.mesh);

  // ---- 湖东野径：单车道土路环线（绕湖一整圈，两端都咬在湖滨环岛上）----
  // 会车要借野地；heightAt 在此路上加颠簸噪声 → 车身真实起伏
  // ⚠️ v2.12.2 逐点贴地形铺路（sampleTerrain+0.05）；
  // ⚠️ v2.33 去掉 0.044 下限：贴岸段地形被湖盆下切到 -0.6~-1.16（水面 -1.5 之上），
  //    旧版 max(0.044,…) 让路面悬空 0.6~1.1m、车整台陷进路面以下（巡检 audit_03 实锤）。
  //    地形本身高于水面 → 直接贴地即可，路面始终在水面之上。
  const trailPts = [
    [839, -420], [838, -480], [828, -540], [820, -610], [796, -668],
    [752, -700], [690, -714], [628, -706], [566, -686], [524, -650],
    [500, -600], [496, -556], [498, -505], [494, -470], [520, -448],
    [556, -448], [600, -424], [660, -415], [700, -420], [752, -446],
    [800, -464], [836, -458], [839, -426],
  ];
  const trail = ribbon(
    trailPts.map(([x, z]) => new THREE.Vector3(x, sampleTerrain(x, z) + 0.05, z)),
    true, 4.5, { roughness: 1, follow: 0.05, minY: -5 }, 3
  );
  group.add(trail.mesh);

  // ---- 湖西环路（v2.13）：高速南段 ↔ 湖滨环岛，绕湖西形成环湖通路西半环 ----
  // ⚠️ 贴地形铺路（sampleTerrain+0.05）：南段穿过湖盆坡带外缘，固定 y 会悬空
  let westLakePts, westLakeRoad;
  {
    const hp = nearestCurvePoint(highway.curve, 620, -760, (p) => p.z < -560);
    const raw = [
      [hp.x, hp.z],
      [520, -740], [455, -650], [442, -545], [470, -450], [545, -378], [645, -338], [740, -348], [810, -400],
    ];
    // v2.33 末点伸进环岛圈带（r16~24）：旧端点 (800,-392) 距环岛中心 34m，断在草地上
    westLakePts = raw.map(([x, z]) => new THREE.Vector3(x, Math.max(0.02, sampleTerrain(x, z) + 0.05), z));
    westLakePts[0].y = hp.y + 0.03; // 端点略抬，压高速防共面
    westLakeRoad = ribbon(westLakePts, false, 9, { color: 0x9a9184, roughness: 1, follow: 0.05, minY: 0.02, curb: false });
    group.add(westLakeRoad.mesh);
  }

  // ---- 西南连接线（v2.13）：乡道西南段 ↔ 高速西南段，缝合西南象限路网 ----
  // T 形接入乡道（近垂直），端点伸进高速 4m；全程平地固定 y 防搭接
  let swLinkPts, swLinkRoad;
  {
    const hp = nearestCurvePoint(highway.curve, -320, -520, (p) => p.z < -380);
    swLinkPts = [
      new THREE.Vector3(-620, 0.032, -560),
      new THREE.Vector3(-500, 0.032, -568),
      new THREE.Vector3(-390, 0.032, -552),
      new THREE.Vector3(hp.x + 20, 0.032, hp.z - 4),
      new THREE.Vector3(hp.x + 4, 0.032, hp.z),
    ];
    swLinkRoad = ribbon(swLinkPts, false, 10, { roughness: 0.9 });
    group.add(swLinkRoad.mesh);
  }

  // ---- 桥（跨下切河道：桥面 y=1.2 高出水面 2.7m；梁 + 4 桥墩入水）----
  // ⚠️ 旧版栏杆沿 Z 摆放与过河方向垂直（等于横在路中间的栅栏），已纠正
  const bridgeConcrete = addSurfaceFinish(createRoadMaterial('concrete', {color:0x8c887f,roughness:.9}), 'stone');
  const bridgeSteel = new THREE.MeshStandardMaterial({color:0x505b59,roughness:.64,metalness:.5});
  const supports = [], steelwork = [];
  for (const x of [-936,-912,-888,-864]) {
    supports.push([x,-1.76,60,2.0,5.0,6.2], [x,.53,60,3.3,.45,8.6]);
  }
  supports.push([-900,.76,61,80,.52,10.8]);
  for (const side of [-1,1]) {
    const z=60+side*5.95;
    for (let x=-940;x<=-860;x+=4) {
      supports.push([x,1.25,z,.34,.24,.46]);
      steelwork.push([x,1.82,z,.12,1.08,.14]);
    }
    steelwork.push([-900,1.59,z,80,.12,.14],[-900,2.18,z,80,.12,.16]);
  }
  // The southern crossing already has a road deck; give it visible support over the riverbed.
  const southCrossing = country.samples.filter(({ pos }) => Math.abs(pos.x - RIVER_X) < 40 && pos.z < -650);
  for (let i = 0; i < southCrossing.length; i += 3) {
    const { pos } = southCrossing[i];
    const bottom = groundSampler(pos.x, pos.z) - .3;
    supports.push([pos.x, (bottom + pos.y) / 2, pos.z, 2.2, pos.y - bottom, 3.6]);
  }
  boxBatch(group,'bridge-concrete',bridgeConcrete,supports,true);
  boxBatch(group,'bridge-rails',bridgeSteel,steelwork,true);

  // ---- 河流（v2.24 水面材质升级：波浪/菲涅尔/泡沫 + 世界坐标岸线场）----
  // 水线由地形反推：cutBand(|x+900|,20,60,2.2) 中 h=-1.5 处 ≈ |x+900|=34.4，
  // 水面网格比水线略宽（76m），出界部分被抬升的地形天然遮住
  const riverNormal = makeWaterNormal();
  riverNormal.repeat.set(9, 404); // ~8.4m/格
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(76, RIVER.halfLength * 2, 8, 420),
    makeWaterMaterial({
      deep: 0x304f57, shallow: 0x648071, foam: .32, glint: .63,
      shoreMode: 'band', center: [RIVER_X, 0], shoreR: RIVER.halfWidth,
      band: 9, foamBand: 2.5, waveAmp: 0.042,
      normalTex: riverNormal, normalScale: 0.55, repeat: 9,
    })
  );
  river.rotation.x = -Math.PI / 2;
  river.position.set(RIVER_X, -1.5, 0);
  group.add(river);

  // ---- 第二湖（山脚下：水面沉降到盆底 -1.5m；v2.24 换方形细分网格承载顶点波浪）----
  // 水线反推：cutRadial(inner 176, outer 215, depth 1.8) 中 h=-1.5 处 ≈ d=186
  const lake2Normal = makeWaterNormal();
  lake2Normal.repeat.set(27, 27); // ~16m/格
  const lake2 = new THREE.Mesh(
    new THREE.PlaneGeometry(430, 430, 64, 64),
    makeWaterMaterial({
      deep: 0x154052, shallow: 0x407480, foam: .22, glint: .75,
      shoreMode: 'circle', center: [FOOTHILL_LAKE.x, FOOTHILL_LAKE.z], shoreR: FOOTHILL_LAKE.r,
      band: 28, foamBand: 3.5, waveAmp: 0.07,
      normalTex: lake2Normal, normalScale: 0.4, repeat: 27,
    })
  );
  lake2.rotation.x = -Math.PI / 2;
  lake2.position.set(FOOTHILL_LAKE.x, -1.5, FOOTHILL_LAKE.z);
  group.add(lake2);

  // ---- 城市楼房 + 街区公园 ----
  // v2.33 建筑碰撞体：轴对齐脚印 {x, z, hw, hd}（楼块 rotation.y=0，玩家车圆-AABB 推出用）
  // ⚠️ 声明在块外：块内收集，buildWorld 末尾 return 导出
  const bldColliders = [], storefrontAnchors = [], signalHeads = [];
  let streetGlazing, citySidewalks;
  // 巷道从街区正中穿过 → 楼房退到四象限（更小更密，城市感更强）
  // 公园街区：四象限草坪（矩形避开巷道与主街）+ 一个水池
  const PARK_BLOCKS = new Set(['1_2', '2_0']);
  {
    const bldGeo = new THREE.BoxGeometry(1, 1, 1);
    // v2.25 楼群重制：按楼高分桶 → 每桶克隆立面贴图调 repeat，楼层高度恒定 ~3.2m
    // （旧版一张 128px 贴图拉伸到 24~104m，楼层 3~13m 不等 + 低分辨率 = 大块模糊色块）
    const facadeBase = makeFacadeTexture();
    const facadeEmit = makeFacadeEmissive();
    facadeBase.wrapS = facadeBase.wrapT = THREE.RepeatWrapping;
    facadeEmit.wrapS = facadeEmit.wrapT = THREE.RepeatWrapping;
    facadeBase.repeat.set(2, 1); facadeEmit.repeat.set(2, 1);
    const N_BLD = 72;
    // [高度区间, 基准楼高（算 repeat.y）]
    const BLD_BUCKETS = [[[24, 46], 35], [[46, 74], 60], [[74, 110], 92]];
    const bldBuckets = BLD_BUCKETS.map(([, hRef]) => {
      const map = facadeBase.clone(); map.needsUpdate = true;
      const ems = facadeEmit.clone(); ems.needsUpdate = true;
      const ry = Math.max(2, Math.round(hRef / 12.8)); // tile = 4 层 ×3.2m
      map.repeat.set(2, ry); ems.repeat.set(2, ry);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map, emissiveMap: ems, roughnessMap: facadeFinish(map, false),
        emissive: 0xffdd88, emissiveIntensity: 0.12,
        roughness: 0.85, metalness: 0.06, envMapIntensity: 0.55,
      });
      const mesh = new THREE.InstancedMesh(bldGeo, mat, N_BLD);
      mesh.castShadow = true;
      mesh.userData.cnt = 0;
      return mesh;
    });
    // v2.25 玻璃幕墙塔：独立幕墙贴图（竖肋+层间带+玻璃渐变），高反射，按高度 2 桶
    const glassBase = makeGlassTexture();
    glassBase.wrapS = glassBase.wrapT = THREE.RepeatWrapping;
    glassBase.repeat.set(2, 1);
    const N_GLASS = 26;
    const GLASS_BUCKETS = [[[40, 80], 60], [[80, 125], 100]];
    const glassBuckets = GLASS_BUCKETS.map(([, hRef]) => {
      const map = glassBase.clone(); map.needsUpdate = true;
      map.repeat.set(2, Math.max(3, Math.round(hRef / 10))); // tile ≈ 3 层楼
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc1c9c5, map, roughnessMap: facadeFinish(map, true), metalness: .17, roughness: .56, envMapIntensity: .87,
      });
      const mesh = new THREE.InstancedMesh(bldGeo, mat, N_GLASS);
      mesh.castShadow = true;
      mesh.userData.cnt = 0;
      return mesh;
    });
    // 楼顶设备（空调箱/水塔）：贴楼顶的小盒子群
    const roofGeo = new THREE.BoxGeometry(1, 1, 1);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.85, metalness: 0.3 });
    const rooftops = new THREE.InstancedMesh(roofGeo, roofMat, N_BLD * 2 + N_GLASS * 2);
    rooftops.castShadow = true;
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const masonry = [], frames = [], glazing = [];
    function buildingDetails(owner, baseY, h, glass) {
      const { x, z, hw, hd } = owner, w = hw * 2, d = hd * 2;
      const towardStreet = Math.sign(1170 - x);
      masonry.push([x,1.65,z,w+.025,3.3,d+.025], [x,h+.22,z,w+.026,.44,d+.026]);
      for (const side of [-1,1]) {
        for (const end of [-1,1]) {
          masonry.push([x+side*(w/2-.32),h*.52,z+end*(d/2-.32),.69,h*.94,.69]);
        }
        for (const level of [3.35, h*.56]) {
          frames.push([x,level,z+side*(d/2-.08),w,.42,.2], [x+side*(w/2-.08),level,z,.2,.42,d]);
        }
        const oldGlazing = [];
        for (let i=-2;i<=2;i++) {
          oldGlazing.push(glazing.length);
          const zw=z+i*d/6, xw=x+i*w/6;
          // The opaque plinth is recessed from these glass panels by 2 cm.
          glazing.push([x+side*(w/2+.022),1.75,zw,.045,2.35,d*.145], [xw,1.75,z+side*(d/2+.022),w*.145,2.35,.045]);
        }
        if (side === towardStreet && Math.abs(1170 - x) <= 40 && z + hd >= 490 && z - hd <= 600) {
          storefrontAnchors.push({ owner, side, wall: x + side * hw, lo: z - hd, hi: z + hd,
            baseY, oldGlazing });
        }
      }
      if (glass) frames.push([x,h+1.3,z,w*.47,2.1,d*.51]);
    }
    let placed = 0, glassPlaced = 0, roofN = 0;
    for (let bi = 0; bi < xs.length - 1; bi++) {
      for (let bj = 0; bj < zs.length - 1; bj++) {
        const bx = (xs[bi] + xs[bi + 1]) / 2; // 区块中心（巷道穿过）
        const bz = (zs[bj] + zs[bj + 1]) / 2;
        if (PARK_BLOCKS.has(`${bi}_${bj}`)) {
          // 公园草坪：四象限矩形，中心 (bx±28, bz±30)，半宽 22/24 恰好卡进
          // 主街内缘与巷道外缘之间（不与任何路面重叠 → 无 Z-fighting）
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const lawn = new THREE.Mesh(
                new THREE.PlaneGeometry(44, 48),
                new THREE.MeshStandardMaterial({ color: 0x4f8046, roughness: 1 })
              );
              lawn.rotation.x = -Math.PI / 2;
              lawn.position.set(bx + sx * 28, 0.05, bz + sz * 30);
              lawn.receiveShadow = true;
              group.add(lawn);
            }
          }
          // 公园水池（v2.24 换新水面材质：小波幅 + 岸线泡沫圈）
          const pondNormal = makeWaterNormal();
          pondNormal.repeat.set(2, 2);
          const pond = new THREE.Mesh(
            new THREE.CircleGeometry(14, 28),
            makeWaterMaterial({
              deep: 0x1f629a, shallow: 0x4a93b0, glint: 0.8,
              shoreMode: 'circle', center: [bx + 28, bz + 30], shoreR: 14,
              band: 2.5, foamBand: 1.2, waveAmp: 0.012,
              normalTex: pondNormal, normalScale: 0.3, repeat: 2,
            })
          );
          pond.rotation.x = -Math.PI / 2;
          pond.position.set(bx + 28, 0.062, bz + 30);
          group.add(pond);
          continue;
        }
        // 楼房：象限中心 ±(26,28)，脚手印 20-32m，最多伸入巷道外缘 1.5m 余量内
        const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]].sort(() => Math.random() - 0.5);
        const n = 2 + (Math.random() < 0.5 ? 1 : 0);
        for (let k = 0; k < n && placed < N_BLD; k++) {
          const [qx, qz] = quads[k];
          const w = 20 + Math.random() * 12;
          const h = 24 + Math.random() * 80;
          const dpt = 20 + Math.random() * 12;
          dummy.position.set(
            bx + qx * 26 + (Math.random() - 0.5) * 5, h / 2,
            bz + qz * 28 + (Math.random() - 0.5) * 5
          );
          dummy.scale.set(w, h, dpt);
          dummy.rotation.y = 0;
          dummy.updateMatrix();
          // v2.33 记录建筑脚印碰撞体
          bldColliders.push({
            x: dummy.position.x, z: dummy.position.z,
            hw: w / 2, hd: dpt / 2,
          });
          buildingDetails(bldColliders.at(-1), dummy.position.y - h / 2, h, false);
          const bucket = bldBuckets[h < 46 ? 0 : h < 74 ? 1 : 2];
          const bi = bucket.userData.cnt;
          if (bi < N_BLD) {
            bucket.setMatrixAt(bi, dummy.matrix);
            // v2.13 楼身色彩多样化：暖白/灰蓝/砖红/深灰随机域（新立面基底亮，色板更出效果）
            const palette = [
              [1.06, 1.04, 0.98], [0.92, 1.06, 1.18], [1.12, 0.86, 0.80],
              [0.88, 0.90, 0.96], [1.02, 1.00, 1.06], [1.10, 1.08, 0.88],
              [0.90, 1.02, 0.92],
            ];
            const pv = palette[(Math.random() * palette.length) | 0];
            const tt = 0.66 + Math.random() * 0.5;
            tint.setRGB(tt * pv[0], tt * pv[1], tt * pv[2]);
            bucket.setColorAt(bi, tint);
            bucket.userData.cnt++;
          }
          // 楼顶设备 1-2 件
          const rn = 1 + (Math.random() < 0.5 ? 1 : 0);
          for (let r = 0; r < rn && roofN < rooftops.count; r++) {
            dummy.position.set(
              bx + qx * 26 + (Math.random() - 0.5) * w * 0.4, h + 1.1,
              bz + qz * 28 + (Math.random() - 0.5) * dpt * 0.4
            );
            dummy.scale.set(2.5 + Math.random() * 3, 2.2, 2 + Math.random() * 2.5);
            dummy.updateMatrix();
            rooftops.setMatrixAt(roofN++, dummy.matrix);
          }
          placed++;
        }
        // v2.13 剩余象限补玻璃幕墙塔：脚手印小 (14-22m)，天际线更立体
        if (glassPlaced < N_GLASS && n < 4) {
          const [qx, qz] = quads[n];
          const w = 14 + Math.random() * 8;
          const h = 40 + Math.random() * 85;
          const dpt = 14 + Math.random() * 8;
          dummy.position.set(
            bx + qx * 26 + (Math.random() - 0.5) * 5, h / 2,
            bz + qz * 28 + (Math.random() - 0.5) * 5
          );
          dummy.scale.set(w, h, dpt);
          dummy.updateMatrix();
          // v2.33 玻璃塔同样记录脚印碰撞体
          bldColliders.push({
            x: dummy.position.x, z: dummy.position.z,
            hw: w / 2, hd: dpt / 2,
          });
          buildingDetails(bldColliders.at(-1), dummy.position.y - h / 2, h, true);
          const gbucket = glassBuckets[h < 80 ? 0 : 1];
          const gi = gbucket.userData.cnt;
          if (gi < N_GLASS) {
            gbucket.setMatrixAt(gi, dummy.matrix);
            const gt = 0.85 + Math.random() * 0.3;
            tint.setRGB(gt, gt * 1.02, gt * 1.05);
            gbucket.setColorAt(gi, tint);
            gbucket.userData.cnt++;
          }
          dummy.position.set(
            bx + qx * 26, h + 1.0, bz + qz * 28
          );
          dummy.scale.set(4, 2, 3);
          dummy.updateMatrix();
          if (roofN < rooftops.count) rooftops.setMatrixAt(roofN++, dummy.matrix);
          glassPlaced++;
        }
      }
    }
    for (const m of bldBuckets) { m.count = m.userData.cnt; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    for (const m of glassBuckets) { m.count = m.userData.cnt; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    rooftops.count = roofN;
    group.add(...bldBuckets, ...glassBuckets, rooftops);
    boxBatch(group,'building-plinths',addSurfaceFinish(new THREE.MeshStandardMaterial({color:0x797368,roughness:.92}),'stone'),masonry);
    boxBatch(group,'building-metalwork',new THREE.MeshStandardMaterial({color:0x545a58,roughness:.63,metalness:.35}),frames);
    streetGlazing = boxBatch(group,'building-street-glazing',new THREE.MeshStandardMaterial({color:0x34484e,roughness:.33,metalness:.16,envMapIntensity:.8}),glazing);
  }

  // Paint stops at the junction, not across the crossing traffic lanes.
  {
    const vertical = cityStreets.filter((s) => s.ax === s.bx).sort((a,b) => a.ax-b.ax);
    const horizontal = cityStreets.filter((s) => s.az === s.bz).sort((a,b) => a.az-b.az);
    const patches = [], walks = [], zebra = [];
    const { map, roughness } = makeJunctionTextures();
    for (const v of vertical) for (const h of horizontal) {
      patches.push([v.ax,.040,h.az,v.width+.12,.007,h.width+.12]);
    }
    for (const [streets, cuts, alongZ] of [[vertical,horizontal,true],[horizontal,vertical,false]]) {
      for (const street of streets) for (let i=1;i<cuts.length;i++) {
        const a=(alongZ?cuts[i-1].az:cuts[i-1].ax)+cuts[i-1].width/2+2;
        const b=(alongZ?cuts[i].az:cuts[i].ax)-cuts[i].width/2-2;
        for (const side of [-1,1]) {
          const offset=(alongZ?street.ax:street.az)+side*(street.width/2+1.04);
          walks.push(alongZ ? [offset,.066,(a+b)/2,1.8,.11,b-a] : [(a+b)/2,.066,offset,b-a,.11,1.8]);
        }
      }
    }
    for (const [x,z] of signalJunctions) for (const side of [-1,1]) for (let k=-4;k<=4;k++) {
      zebra.push([x+k*.86,.052,z+side*4.88,.43,.005,1.38], [x+side*4.88,.052,z+k*.86,1.38,.005,.43]);
    }
    boxBatch(group,'city-junctions',createRoadMaterial('asphalt',{map,roughnessMap:roughness}),patches);
    citySidewalks = boxBatch(group,'city-sidewalks',createRoadMaterial('concrete',{color:0x938e83}),walks);
    boxBatch(group,'city-crosswalks',createRoadMaterial('marking',{color:0xdfd8c8}),zebra);
  }

  // ---- 红绿灯（城市主要路口，按方向分相）----
  const lights = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.5 });
  for (const [i, [lx, lz]] of signalJunctions.entries()) {
    const heads = {};
    for (const [axis, dx, dz] of [['x', 7.5, -7.5], ['z', 7.5, 7.5]]) {
      const head = new THREE.Group();
      head.position.set(lx + dx, 0, lz + dz);
      head.rotation.y = axis === 'x' ? Math.PI / 2 : 0;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 6.5, 8), poleMat);
      pole.position.y = 3.25;
      head.add(pole);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.5), poleMat);
      box.position.y = 6.2;
      head.add(box);
      heads[axis] = [0xff2222, 0xffcc22, 0x22ff44].map((c, k) => {
        const material = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 0.08 });
        for (const sign of [-1, 1]) {
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), material);
          lamp.position.set(0, 7.05 - k * 0.85, sign * 0.29);
          head.add(lamp);
        }
        return material;
      });
      group.add(head);
      signalHeads.push(head);
    }
    lights.push({ pos: new THREE.Vector3(lx, 0, lz), heads, offset: i * 5 });
  }
  let cycle = 0;
  function signalAt(light, axis) {
    const phase = (cycle + light.offset + (axis === 'z' ? 14 : 0)) % 28;
    return phase < 10 ? 2 : phase < 12 ? 1 : 0;
  }
  function update(dt) {
    cycle = (cycle + dt) % 28;
    for (const light of lights) for (const axis of ['x', 'z']) {
      const state = signalAt(light, axis);
      light.heads[axis].forEach((m, i) => { m.emissiveIntensity = i === state ? 2.2 : 0.08; });
    }
    // 水面动画（v2.24：water.js 统一推进波浪相位 + 法线贴图滚动）
    const t = performance.now() * 0.001;
    updateWater(t);
    // 地标塔警示灯闪烁
    const blink = Math.sin(t * 3) > 0 ? 2.2 : 0.15;
    for (const b of beaconBlinks) b.mesh.material.emissiveIntensity = blink;
  }

  // ---- 查询 ----
  // 颠簸土路噪声：乡道 + 野径（确定性三频正弦，随位置变化不闪变）
  function bumpNoise(x, z) {
    return (Math.sin(x * 1.9) + Math.sin(z * 2.3) + Math.sin((x + z) * 1.3)) * 0.033;
  }
  // Same triangles as the visible ribbon, including both river crossings and banked roads.
  function heightAt(pos) {
    const { x, z } = pos;
    const ground = groundSampler(x, z);
    const deck = roadIndex.deckAt(x, z);
    const height = deck === null ? ground : Math.max(ground, deck);
    return height + (deck !== null && surfaceAt(pos) === 'dirt' ? bumpNoise(x, z) : 0);
  }
  // 是否在城市路网 / 高速上（离路判定用）
  function distToCityRoads(x, z) {
    let best = Infinity;
    for (const s of cityStreets) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)));
    }
    return best;
  }
  function isOnCityRoad(pos) {
    return distToCityRoads(pos.x, pos.z) <= 7;
  }

  const roads = Object.entries({ highway, eastConn: eastConnRoad, southConn: southConnRoad,
    lakeRoad, roundabout, national, mountainRoad, summitRing, trail, westLake: westLakeRoad,
    swLink: swLinkRoad, country }).map(([id, route]) => ({ ...route, id,
      kind: id === 'trail' || id === 'country' ? 'dirt' : 'pave' }));
  for (const [i, st] of cityStreets.entries()) {
    roads.push({ id: `city${i}`, kind: 'pave', samples: [
      { pos: { x: st.ax, y: 0.02, z: st.az }, w: st.width },
      { pos: { x: st.bx, y: 0.02, z: st.bz }, w: st.width },
    ] });
  }
  const roadIndex = buildRoadIndex(roads);
  function surfaceAt({ x, z }) {
    return northInterchange.contains(x, z) ? 'pave' : roadIndex.surfaceAt(x, z);
  }
  const onAnyRoad = (pos) => surfaceAt(pos) !== null;
  const distToRoads = (x, z) => Math.min(roadIndex.distance(x, z), northInterchange.distance(x, z));

  // ---- 冲刺/越野赛路线（v2.32）----
  // routeFromPoints：任意点列 → 轻量路线对象（curve+samples+length，无路面网格）；
  // 冲刺赛从现有 ribbon 抽样切片（零建模成本），越野赛由野径 trail 横向扰动生成
  const routeFromPoints = (pts, width, id) => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
    const length = curve.getLength();
    const n = Math.max(8, Math.round(length / 4));
    const samples = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const pos = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      samples.push({ pos, tan, side: new THREE.Vector3(tan.z, 0, -tan.x), w: width });
    }
    return { id, curve, samples, length, width,
      startPos: samples[0].pos.clone(), endPos: samples[n].pos.clone() };
  };
  const sliceRoute = (ribbon, t0, t1, id) => {
    const s = ribbon.samples;
    const i0 = Math.floor(s.length * t0), i1 = Math.min(s.length - 1, Math.ceil(s.length * t1));
    const pts = [];
    for (let k = i0; k <= i1; k++) pts.push(s[k].pos.clone());
    return routeFromPoints(pts, s[i0].w, id);
  };
  // The canyon race actually crosses the river: continue onto the country bridge.
  const approachBridge = [...national.samples.slice(9).map(s => s.pos.clone())];
  const join = approachBridge.at(-1);
  let countryStart = 0;
  for (let i = 1; i < country.samples.length / 4; i++) {
    if (country.samples[i].pos.distanceToSquared(join) < country.samples[countryStart].pos.distanceToSquared(join)) countryStart = i;
  }
  for (const { pos } of country.samples.slice(countryStart + 1)) {
    approachBridge.push(pos.clone());
    if (pos.x < -1000) break;
  }
  const sprintRoutes = {
    highway: sliceRoute(highway, 0.03, 0.42, 'sprint_highway'),
    canyon: routeFromPoints(approachBridge, 8, 'sprint_canyon'),
    lakeside: sliceRoute(westLakeRoad, 0.045, 0.985, 'sprint_lakeside'),
  };
  // 越野赛·湖东狂飙：沿野径外缘绕湖，控制点避水。
  {
    const offs = [0, -10, -18, -12, -8, -16, -14, -5, -14, -18, -10, 0];
    const N = 12;
    const pts = [];
    for (let k = 0; k < N; k++) {
      const s = trail.samples[Math.round((k / (N - 1)) * (trail.samples.length - 1))];
      let p = s.pos.clone().addScaledVector(s.side, offs[k]);
      let h = sampleTerrain(p.x, p.z);
      if (h < -0.3) { p = s.pos.clone(); h = sampleTerrain(p.x, p.z); } // 避水回撤
      p.y = Math.max(0.05, h + 0.22);
      pts.push(p);
    }
    sprintRoutes.offroad = routeFromPoints(pts, 14, 'offroad_stampede');
  }

  const lines = (...routes) => routes.map(route => route.samples.map(({ pos }) => [pos.x, pos.z]));
  const mapRoads = {
    highway: lines(highway),
    arterial: lines(national, eastConnRoad, southConnRoad, swLinkRoad, lakeRoad),
    ramps: northInterchange.minimap,
    local: [...cityStreets.map(s => [[s.ax, s.az], [s.bx, s.bz]]),
      ...lines(westLakeRoad, roundabout, mountainRoad, summitRing)],
    dirt: lines(country, trail),
    bridge: [lines(country)[0].filter(([x, z]) => Math.abs(x - RIVER.x) <= 40 && Math.abs(z - 61) < 10),
      southCrossing.map(({ pos }) => [pos.x, pos.z])],
  };
  const guide = worldGuide({ MT, northInterchange, national, country, lakeRoad, westLakeRoad, mountainRoad, eastConnRoad, southConnRoad });
  addWorldSigns(group, guide, groundSampler, (x, z) => distToRoads(x, z) > 7 && !onAnyRoad({ x, z }) &&
    !bldColliders.some(b => Math.abs(x - b.x) < b.hw + .8 && Math.abs(z - b.z) < b.hd + .8));

  const corridor = addShowcaseCorridor(group, { highway, country, bldColliders, groundSampler, onAnyRoad });
  const wayfinding = group.getObjectByName('world-wayfinding');
  const addStorefronts = (props) => addNorthStorefronts(group, {
    storefrontAnchors, streetGlazing, cityStreets, roads, surfaceAt, bldColliders, corridor,
    interchangePavement: northInterchange.group.children.filter(mesh => mesh.renderOrder === 1),
    obstacles: [citySidewalks, wayfinding, ...signalHeads, ...props],
  });

  // v2.33 缘石统一挂接：所有路建完后执行（交叉路口条带剔除）
  // Highway kerb jobs store the +side first and the inner (-side) second.
  const highwaySegments = highway.samples.length - 1;
  attachCurbs((roadId, quad) => roadId === 0 && quad >= highwaySegments &&
    northInterchange.replacesCurb(quad - highwaySegments));

  return {
    group, highway, cityRoute, country, cityStreets,
    eastConn: eastConnRoad, southConn: southConnRoad, northInterchange,
    westLake: westLakeRoad, swLink: swLinkRoad, approachJunctions, approachTraffic,
    lakeRoad, roundabout, national, mountainRoad, summitRing, trail,
    sprintRoutes, bldColliders,
    terrainH, sampleTerrain, groundSampler, MT,
    lights, update, signalAt,
    heightAt, isOnCityRoad, distToCityRoads,
    onAnyRoad, surfaceAt, distToRoads,
    roads, mapRoads, guide, addStorefronts,
  };
}
