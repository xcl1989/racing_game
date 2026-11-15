// world.js — 开放大世界：高速公路 / 城市街区 / 乡道桥梁 / 河流 / 红绿灯 / NPC 路线
import * as THREE from 'three';
import { makeAsphaltTextures, makeGrassTexture, makeWindowsTexture, makeWaterNormal } from './textures.js';

// 通用道路带状网格构建：pts 含 y（桥面抬升用）
function ribbon(pts, closed, width, matOpts = {}) {
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', 0.5);
  const SEG = Math.max(64, Math.floor(curve.getLength() / 8));
  const asphalt = makeAsphaltTextures();
  const verts = [], uvs = [], idx = [];
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
    verts.push(L.x, L.y, L.z, R.x, R.y, R.z);
    const v = dist / 6;
    uvs.push(0, v, 1, v);
    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const map = asphalt.map.clone();
  map.needsUpdate = true;
  map.repeat.set(1, 1);
  const normal = asphalt.normal.clone();
  normal.needsUpdate = true;
  const roughTex = asphalt.roughness.clone();
  roughTex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap: normal, normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: roughTex,
    roughness: 0.92, metalness: 0.04, envMapIntensity: 0.5, ...matOpts,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  const samples = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).setY(0).normalize();
    samples.push({ pos: p, tan, side: up.clone().cross(tan).normalize() });
  }
  return { mesh, curve, samples, length: curve.getLength() };
}

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

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
  const highway = ribbon(hPts, true, 20);
  group.add(highway.mesh);

  // ---- 城市街区路网（中心 1050,350）----
  // ⚠️ 路面高度分层错开防 Z-fighting；街道端点收齐成规矩 T 形/十字路口：
  //    纵街 z 跨 84..616（与横街 z=90/610 的远边缘齐平），横街 x 跨 804..1296
  //    —— 旧版两端多伸出 60m 直插草地，形成"断头路"
  const cityStreets = [];
  const CX = 1050, CZ = 350;
  const xs = [810, 930, 1050, 1170, 1290];
  const zs = [90, 220, 350, 480, 610];
  const Y_STREET = 0.012, Y_AVE = 0.026;
  for (const sx of xs) {
    const r = ribbon(
      [new THREE.Vector3(sx, Y_STREET, zs[0] - 6), new THREE.Vector3(sx, Y_STREET, zs[4] + 6)],
      false, 12, { roughness: 0.92 }
    );
    group.add(r.mesh);
    cityStreets.push({ ax: sx, az: zs[0] - 6, bx: sx, bz: zs[4] + 6, width: 12 });
  }
  for (const sz of zs) {
    const r = ribbon(
      [new THREE.Vector3(xs[0] - 6, Y_AVE, sz), new THREE.Vector3(xs[4] + 6, Y_AVE, sz)],
      false, 12, { roughness: 0.92 }
    );
    group.add(r.mesh);
    cityStreets.push({ ax: xs[0] - 6, az: sz, bx: xs[4] + 6, bz: sz, width: 12 });
  }

  // 城市行驶路线（NPC 环线）：只保留曲线供车流使用，不铺实体路面
  // —— 旧版沿街再铺一条 2.6cm 高的路，与街道长距离平行共面会闪
  const Y_ROUTE = 0.03;
  const cityRoutePts = [
    new THREE.Vector3(1050, Y_ROUTE, 90),
    new THREE.Vector3(1050, Y_ROUTE, 220),
    new THREE.Vector3(1170, Y_ROUTE, 290),
    new THREE.Vector3(1170, Y_ROUTE, 350),
    new THREE.Vector3(1170, Y_ROUTE, 480),
    new THREE.Vector3(1050, Y_ROUTE, 550),
    new THREE.Vector3(930, Y_ROUTE, 480),
    new THREE.Vector3(930, Y_ROUTE, 350),
    new THREE.Vector3(930, Y_ROUTE, 220),
    new THREE.Vector3(930, Y_ROUTE, 90),
  ];
  const cityRoute = ribbon(cityRoutePts, true, 12);
  // 不 add(cityRoute.mesh)：路线隐于街道之下，车流直接"开在"街道上

  // ---- 乡间小道：西部闭环（垂直跨河的正经桥）----
  // ⚠️ 布局原则：
  //   1. 全程在赛道西侧外围（最近点距赛道 ≥ 175m），不发卡弯、不压赛道
  //      —— 旧版起点压赛道造成 Z-fighting，抬高又成"3cm 高架"
  //   2. 桥沿 X 轴垂直跨河：引道加密集过渡点压制 CatmullRom 过冲
  //      —— 旧版 4 点悬空过桥被样条织成 S 形"水上漂"
  const Y_COUNTRY = 0.02;
  const RIVER_X = -900, RIVER_W = 90;
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
  const country = ribbon(cPts, true, 8, { color: 0x9a9184, roughness: 1 }); // 乡道土色
  group.add(country.mesh);

  // ---- 桥（桥面由乡道曲线 y=1.2 提供；栏杆沿 X 与桥面同向 + 桥墩在桥端）----
  // ⚠️ 旧版栏杆沿 Z 摆放与过河方向垂直（等于横在路中间的栅栏），已纠正
  const bridgeCenter = new THREE.Vector3(RIVER_X, 0, 60);
  const bridgeMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.6, metalness: 0.4 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.7, roughness: 0.4 });
  for (const px of [-860, -940]) { // 桥墩：桥面两端落在水面的位置
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 6, 8), bridgeMat);
    pillar.position.set(px, -1, 60);
    group.add(pillar);
  }
  for (const side of [-1, 1]) {
    for (const dy of [1.9, 2.3]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(140, 0.16, 0.3), // 沿 X：与桥面同向
        railMat
      );
      rail.position.set(bridgeCenter.x, dy, bridgeCenter.z + side * 4.6);
      group.add(rail);
    }
  }

  // ---- 河流（纵贯蓝带：反射 + 双层滚动法线波纹）----
  const waterNormal = makeWaterNormal();
  const waterNormal2 = waterNormal.clone();
  waterNormal2.needsUpdate = true;
  waterNormal2.repeat.set(11, 11);
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(RIVER_W + 60, 3600),
    new THREE.MeshStandardMaterial({
      color: 0x2a6ea8, metalness: 0.75, roughness: 0.15,
      normalMap: waterNormal, normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 1.4, transparent: true, opacity: 0.94,
    })
  );
  river.rotation.x = -Math.PI / 2;
  river.position.set(RIVER_X, 0.04, 0);
  group.add(river);

  // ---- 第二湖（山脚下：同款水波）----
  const lake2 = new THREE.Mesh(
    new THREE.CircleGeometry(200, 40),
    new THREE.MeshStandardMaterial({
      color: 0x2a6ea8, metalness: 0.8, roughness: 0.12,
      normalMap: waterNormal2, normalScale: new THREE.Vector2(0.3, 0.3),
      envMapIntensity: 1.3,
    })
  );
  lake2.rotation.x = -Math.PI / 2;
  lake2.position.set(-1500, 0.04, -1900);
  group.add(lake2);

  // ---- 城市楼房：对齐街区摆放（块内随机 1-2 栋）----
  const N_BLD = 60;
  const bldGeo = new THREE.BoxGeometry(1, 1, 1);
  const bldMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: makeWindowsTexture(),
    emissiveMap: (function () {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#000';
      x.fillRect(0, 0, 64, 128);
      for (let wy = 6; wy < 124; wy += 10) {
        for (let wx = 5; wx < 60; wx += 10) {
          if (Math.random() < 0.18) {
            x.fillStyle = Math.random() < 0.5 ? '#ffe9b0' : '#fff6d8';
            x.fillRect(wx, wy, 6, 6);
          }
        }
      }
      const t = new THREE.CanvasTexture(c);
      return t;
    })(),
    emissive: 0xffdd88, emissiveIntensity: 0.22,
    roughness: 0.42, metalness: 0.32, envMapIntensity: 1.0,
  });
  const blds = new THREE.InstancedMesh(bldGeo, bldMat, N_BLD);
  blds.castShadow = true;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let placed = 0;
  for (let bi = 0; bi < xs.length - 1 && placed < N_BLD; bi++) {
    for (let bj = 0; bj < zs.length - 1 && placed < N_BLD; bj++) {
      const bx = (xs[bi] + xs[bi + 1]) / 2;
      const bz = (zs[bj] + zs[bj + 1]) / 2;
      const n = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let k = 0; k < n && placed < N_BLD; k++) {
        const w = 34 + Math.random() * 26;
        const h = 24 + Math.random() * 80;
        const dpt = 34 + Math.random() * 26;
        dummy.position.set(
          bx + (Math.random() - 0.5) * 18, h / 2,
          bz + (Math.random() - 0.5) * 18
        );
        dummy.scale.set(w, h, dpt);
        dummy.rotation.y = 0;
        dummy.updateMatrix();
        blds.setMatrixAt(placed, dummy.matrix);
        const tt = 0.75 + Math.random() * 0.4;
        tint.setRGB(tt * 1.05, tt * 1.12, tt * 1.28);
        blds.setColorAt(placed, tint);
        placed++;
      }
    }
  }
  blds.count = placed;
  blds.instanceColor.needsUpdate = true;
  group.add(blds);

  // ---- 红绿灯（城市主要路口，全城同步周期）----
  const lights = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.5 });
  const lampMats = [];
  for (const [lx, lz] of [[1050, 220], [1050, 480], [930, 350], [1170, 350]]) {
    const g2 = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 6.5, 8), poleMat);
    pole.position.set(lx, 3.25, lz);
    g2.add(pole);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.5), poleMat);
    box.position.set(lx, 6.2, lz);
    g2.add(box);
    const lamps = [];
    const cols = [0xff2222, 0xffcc22, 0x22ff44];
    cols.forEach((c, i) => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: c, emissiveIntensity: 0.1, roughness: 0.4,
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 10), m);
      lamp.position.set(lx, 7.05 - i * 0.85, lz);
      g2.add(lamp);
      lamps.push(m);
    });
    group.add(g2);
    lights.push({ pos: new THREE.Vector3(lx, 0, lz), lamps });
  }
  let cycle = 0; // 全城同步：0-8s 绿 → 8-10s 黄 → 10-18s 红
  const CY = 18;

  function update(dt) {
    cycle = (cycle + dt) % CY;
    const isGreen = cycle < 8, isYellow = cycle >= 8 && cycle < 10;
    for (const L of lights) {
      L.lamps[0].emissiveIntensity = (!isGreen && !isYellow) ? 2.2 : 0.08; // 红
      L.lamps[1].emissiveIntensity = isYellow ? 2.2 : 0.08;                // 黄
      L.lamps[2].emissiveIntensity = isGreen ? 2.2 : 0.08;                 // 绿
    }
    // 水面波纹流动（双层反向滚动 → 干涉出自然水波）
    const t = performance.now() * 0.001;
    if (waterNormal) {
      waterNormal.offset.set(t * 0.012, t * 0.02);
      waterNormal2.offset.set(-t * 0.008, t * 0.014);
    }
  }
  const isRed = () => !(cycle < 10);

  // ---- 查询 ----
  // 桥面高度：桥面沿 X 跨 x∈[-860,-940]（|dx|<40 全高 1.2，两端 30m 线性缓坡）
  function heightAt(pos) {
    const dx = Math.abs(pos.x - bridgeCenter.x);
    if (Math.abs(pos.z - bridgeCenter.z) < 6 && dx < 70) {
      return 1.2 * Math.max(0, Math.min(1, (70 - dx) / 30));
    }
    return 0;
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

  // 到高速/乡道路面的粗距离（玩家离路判定用）
  function distToRouteSamples(samples, x, z) {
    let best = Infinity;
    for (let i = 0; i < samples.length; i += 4) {
      const p = samples[i].pos;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < best) best = d;
    }
    return best;
  }
  function onAnyRoad(pos) {
    return isOnCityRoad(pos)
      || distToRouteSamples(highway.samples, pos.x, pos.z) <= 11
      || distToRouteSamples(country.samples, pos.x, pos.z) <= 5.5;
  }
  function distToRoads(x, z) {
    // 供植被/建筑生成避让：高速 + 乡道（城市街道也包含）
    let d = distToCityRoads(x, z);
    d = Math.min(d, distToRouteSamples(highway.samples, x, z));
    d = Math.min(d, distToRouteSamples(country.samples, x, z));
    return d;
  }

  // 小地图折线（画全路网）：高速 / 城市环线 / 乡道 + 城市街道网格逐条补上
  // ⚠️ 旧版只有 3 条折线，站在城市十字路口地图上空空如也
  const streetPolys = cityStreets.map((s) => [[s.ax, s.az], [s.bx, s.bz]]);
  const minimapPolylines = [
    hPts.map((p) => [p.x, p.z]),
    cityRoutePts.map((p) => [p.x, p.z]),
    cPts.map((p) => [p.x, p.z]),
    ...streetPolys,
  ];

  return {
    group, highway, cityRoute, country, cityStreets,
    lights, update, isRed,
    heightAt, isOnCityRoad, distToCityRoads,
    onAnyRoad, distToRoads,
    minimapPolylines,
  };
}
