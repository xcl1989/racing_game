// scenery.js — 大地图装饰：起伏草地/团簇树/岩石/白天质感楼房/雾蓝远山/
// 风力发电机/连续护栏（比赛限定显示）/路灯/广告牌/轮胎墙/看台/草簇/花丛/电线杆/飞鸟
import * as THREE from 'three';
import {
  makeGrassTexture, makeWaterNormal, makeTuftTexture,
  makeBillboardTexture, makeBirdTexture,
} from './textures.js';
import { HALF_WIDTH } from './track.js';

export function buildScenery(scene, track, world, rich = true) {
  // rich=false（手机低配）：植被减量、跳过装饰性 Props
  const D = rich ? 1 : 0.55;      // 植被密度系数
  const skipProps = !rich;
  const samples = track.samples;
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();

  // 到任何道路（环道/直线赛道/高速/乡道/城市街道）的距离
  function distToTrack(x, z) {
    let bd = Infinity;
    for (let i = 0; i < samples.length; i += 8) {
      const p = samples[i].pos;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) bd = d;
    }
    const s = track.strip;
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz)));
    const stripDist = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
    return Math.min(Math.sqrt(bd), stripDist, world.distToRoads(x, z));
  }

  // ---- 地面：大尺度顶点色起伏（打破平铺感）+ 草地纹理 ----
  const groundGeo = new THREE.CircleGeometry(2600, 96);
  {
    const pos = groundGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      // 多频正弦叠加 = 平滑的草地色块起伏（亮绿↔暗绿↔微黄）
      const n1 = Math.sin(x * 0.0045) * Math.cos(y * 0.0035);
      const n2 = Math.sin((x + y) * 0.0016);
      const shade = 0.82 + n1 * 0.13 + n2 * 0.1;
      colors[i * 3] = shade * 1.02;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade * 0.78;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
    map: makeGrassTexture(170), // 平铺更密：34m/格，防手机端马赛克感
    vertexColors: true,
    roughness: 1, metalness: 0,
  }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- 湖 ----
  const lakePos = { x: 620, z: -520 };
  if (distToTrack(lakePos.x, lakePos.z) > 120) {
    const lake = new THREE.Mesh(
      new THREE.CircleGeometry(150, 48),
      new THREE.MeshStandardMaterial({
        color: 0x1c6ba0, metalness: 0.9, roughness: 0.08,
        normalMap: makeWaterNormal(), normalScale: new THREE.Vector2(0.25, 0.25),
        envMapIntensity: 1.5,
      })
    );
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(lakePos.x, 0.05, lakePos.z);
    scene.add(lake);
  }

  // ---- 远景山脉：西北山脊群（大体积，围绕山脚湖）+ 环周背景山 ----
  const mtnMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const mtnGeo = new THREE.ConeGeometry(1, 1, 5);
  const mtn = new THREE.InstancedMesh(mtnGeo, mtnMat, 46);
  let mi = 0;
  // 西北山脊群（体量大，围绕第二湖）
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 250 + Math.random() * 550;
    const w = 280 + Math.random() * 320;
    const h = 190 + Math.random() * 230;
    dummy.position.set(-1500 + Math.cos(a) * r, h / 2 - 6, -1950 + Math.sin(a) * r);
    dummy.scale.set(w, h, w);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    mtn.setMatrixAt(mi, dummy.matrix);
    const t = 0.9 + Math.random() * 0.25;
    tmpColor.setRGB(t * 0.95, t * 1.05, t * 1.2);
    mtn.setColorAt(mi, tmpColor);
    mi++;
  }
  // 环周背景山（接近雾色，若隐若现）
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
    const r = 2350 + Math.random() * 250;
    const w = 180 + Math.random() * 200;
    const h = 120 + Math.random() * 170;
    dummy.position.set(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r);
    dummy.scale.set(w, h, w);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    mtn.setMatrixAt(mi, dummy.matrix);
    const t = 0.8 + Math.random() * 0.25;
    tmpColor.setRGB(t * 0.9, t * 1.0, t * 1.15);
    mtn.setColorAt(mi, tmpColor);
    mi++;
  }
  mtn.count = mi;
  mtn.instanceColor.needsUpdate = true;
  scene.add(mtn);

  // ---- 连续护栏（比赛限定：free 模式隐藏）----
  const railGroup = new THREE.Group();
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xb9bfc6, metalness: 0.85, roughness: 0.35,
  });
  for (const sign of [1, -1]) {
    const pts = [];
    for (let i = 0; i < samples.length; i += 6) {
      const s = samples[i];
      pts.push(s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 1.1)).setY(0.55));
    }
    const railCurve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.2);
    const rail = new THREE.Mesh(new THREE.TubeGeometry(railCurve, 400, 0.06, 6, true), railMat);
    rail.castShadow = true;
    railGroup.add(rail);
    const pts2 = pts.map((p) => p.clone().setY(0.3));
    railGroup.add(new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts2, true, 'catmullrom', 0.2), 400, 0.045, 5, true),
      railMat
    ));
  }
  // 护栏立柱
  const step = 48;
  const nPost = Math.ceil(samples.length / step) * 2;
  const postGeo = new THREE.BoxGeometry(0.26, 0.9, 0.26);
  const postW = new THREE.MeshStandardMaterial({ color: 0xdadde0, roughness: 0.5, metalness: 0.4 });
  const postR = new THREE.MeshStandardMaterial({ color: 0xb02020, roughness: 0.5, emissive: 0x550000, emissiveIntensity: 0.4 });
  const postsW = new THREE.InstancedMesh(postGeo, postW, nPost);
  const postsR = new THREE.InstancedMesh(postGeo, postR, nPost);
  let wi = 0, ri = 0;
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    for (const sign of [1, -1]) {
      const p = s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 1.1));
      dummy.position.set(p.x, 0.45, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      if ((i / step) % 2 === 0) postsW.setMatrixAt(wi++, dummy.matrix);
      else postsR.setMatrixAt(ri++, dummy.matrix);
    }
  }
  postsW.count = wi; postsR.count = ri;
  railGroup.add(postsW, postsR);
  scene.add(railGroup); // 默认隐藏，由 game 按 mode 切换

  // ---- 灌木丛（路外低矮点缀，比树更密）----
  const N_BUSH = Math.round(400 * D);
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const bushes = new THREE.InstancedMesh(bushGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), N_BUSH);
  let placed = 0, tries = 0;
  while (placed < N_BUSH && tries < 4000) {
    tries++;
    const x = (Math.random() * 2 - 1) * 1500;
    const z = (Math.random() * 2 - 1) * 1500;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 4 || d > 300) continue;
    const sc = 0.35 + Math.random() * 0.7;
    dummy.position.set(x, sc * 0.55, z);
    dummy.scale.set(sc, sc * 0.7, sc);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    bushes.setMatrixAt(placed, dummy.matrix);
    const t = 0.7 + Math.random() * 0.5;
    tmpColor.setRGB(0.28 * t, 0.5 * t, 0.25 * t);
    bushes.setColorAt(placed, tmpColor);
    placed++;
  }
  bushes.count = placed;
  bushes.instanceColor.needsUpdate = true;
  scene.add(bushes);

  // ---- 树：树干 + 3 团椭球树冠 ----
  const N_TREE = Math.round(650 * D);
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 2.6, 7);
  const trunk = new THREE.InstancedMesh(trunkGeo,
    new THREE.MeshStandardMaterial({ color: 0x5d4230, roughness: 1 }), N_TREE);
  const leafGeo = new THREE.IcosahedronGeometry(1, 1);
  const canopy = new THREE.InstancedMesh(leafGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), N_TREE * 3);
  trunk.castShadow = canopy.castShadow = true;
  const blobOffsets = [
    [0, 3.4, 0, 1.45], [0.85, 2.9, 0.3, 1.0], [-0.7, 3.0, -0.5, 1.05],
  ];
  placed = 0; tries = 0;
  while (placed < N_TREE && tries < 5000) {
    tries++;
    const x = (Math.random() * 2 - 1) * 1500;
    const z = (Math.random() * 2 - 1) * 1500;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 7 || d > 500) continue;
    const sc = 0.8 + Math.random() * 1.5;
    const tint = 0.75 + Math.random() * 0.45;
    dummy.position.set(x, 1.3 * sc, z);
    dummy.scale.set(sc, sc, sc);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    trunk.setMatrixAt(placed, dummy.matrix);
    for (let b = 0; b < 3; b++) {
      const [ox, oy, oz, bs] = blobOffsets[b];
      dummy.position.set(x + ox * sc, oy * sc, z + oz * sc);
      dummy.scale.set(bs * sc, bs * sc * 0.85, bs * sc);
      dummy.updateMatrix();
      const idx = placed * 3 + b;
      canopy.setMatrixAt(idx, dummy.matrix);
      tmpColor.setRGB(0.24 * tint, 0.44 * tint, 0.22 * tint);
      canopy.setColorAt(idx, tmpColor);
    }
    placed++;
  }
  trunk.count = placed;
  canopy.count = placed * 3;
  canopy.instanceColor.needsUpdate = true;
  scene.add(trunk, canopy);

  // ---- 岩石 ----
  const N_ROCK = Math.round(230 * D);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), N_ROCK);
  placed = 0; tries = 0;
  while (placed < N_ROCK && tries < 3000) {
    tries++;
    const x = (Math.random() * 2 - 1) * 1400;
    const z = (Math.random() * 2 - 1) * 1400;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 5 || d > 350) continue;
    const sc = 0.4 + Math.random() * 1.8;
    dummy.position.set(x, sc * 0.35, z);
    dummy.scale.set(sc * (0.8 + Math.random() * 0.6), sc * 0.7, sc);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    rocks.setMatrixAt(placed, dummy.matrix);
    const g = 0.3 + Math.random() * 0.22; // 压暗：原 0.5-0.8 在强阳光下泛白如石膏
    tmpColor.setRGB(g, g * 1.02, g * 0.96);
    rocks.setColorAt(placed, tmpColor);
    placed++;
  }
  rocks.count = placed;
  rocks.instanceColor.needsUpdate = true;
  rocks.castShadow = true;
  scene.add(rocks);

  // （楼房已迁移至 world.js 城市街区，按路网对齐摆放）

  // ---- 风力发电机（地平线标志物，叶片常转）----
  const rotors = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.5, metalness: 0.3 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.4, metalness: 0.2 });
  let turbines = 0; tries = 0;
  while (turbines < 7 && tries < 800) {
    tries++;
    const x = (Math.random() * 2 - 1) * 900;
    const z = (Math.random() * 2 - 1) * 900;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 25 || d > 1800) continue;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 52, 10), poleMat);
    pole.position.set(x, 26, z);
    pole.castShadow = true;
    scene.add(pole);
    const nacelle = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 4.5), poleMat);
    nacelle.position.set(x, 52, z);
    scene.add(nacelle);
    const rotor = new THREE.Group();
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.1, 21, 0.35), bladeMat);
      blade.position.y = 10.5;
      const arm = new THREE.Group();
      arm.add(blade);
      arm.rotation.z = (b / 3) * Math.PI * 2;
      rotor.add(arm);
    }
    rotor.position.set(x, 52, z + 2.3);
    rotor.userData.speed = 0.5 + Math.random() * 0.6;
    rotors.push(rotor);
    scene.add(rotor);
    turbines++;
  }

  // ============ 场景丰富化 Props（rich 模式专属，全部实例化）============

  // ---- 路灯：沿主环道两侧交错 + 城市街道成排 ----
  const lampPoles = [], lampHeads = [];
  {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 5.2, 6);
    const headGeo = new THREE.SphereGeometry(0.22, 8, 8);
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfff4d0, emissive: 0xffe9b0, emissiveIntensity: 0.25, roughness: 0.3,
    });
    const spots = [];
    for (let i = 0; i < samples.length; i += 55) { // 约 15m 一盏
      const s = samples[i];
      const sign = (i / 55) % 2 ? 1 : -1; // 两侧交错
      spots.push(s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 2.2)));
    }
    // 城市街道两侧各一排（每 25m）
    for (const st of world.cityStreets) {
      const dx = st.bx - st.ax, dz = st.bz - st.az;
      const len = Math.hypot(dx, dz);
      const n = Math.floor(len / 34);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const px = st.ax + dx * t, pz = st.az + dz * t;
        const ox = (-dz / len) * (st.width / 2 + 1.5);
        const oz = (dx / len) * (st.width / 2 + 1.5);
        spots.push(new THREE.Vector3(px + ox, 0, pz + oz));
        spots.push(new THREE.Vector3(px - ox, 0, pz - oz));
      }
    }
    const lamps = new THREE.InstancedMesh(poleGeo, metalMat, spots.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length);
    let li = 0;
    for (const p of spots) {
      dummy.position.set(p.x, 2.6, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      lamps.setMatrixAt(li, dummy.matrix);
      dummy.position.set(p.x, 5.25, p.z);
      dummy.updateMatrix();
      heads.setMatrixAt(li, dummy.matrix);
      li++;
    }
    lamps.count = heads.count = li;
    lamps.castShadow = true;
    scene.add(lamps, heads);
  }

  // ---- 轮胎墙：急弯外侧缓冲（检测样条转角率放置）----
  if (!skipProps) {
    const tireGeo = new THREE.TorusGeometry(0.42, 0.17, 6, 14);
    tireGeo.rotateX(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 });
    const tireWhite = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.85 });
    const stacks = [];
    for (let i = 0; i < samples.length; i += 4) {
      const a = samples[i].tan, b = samples[(i + 16) % samples.length].tan;
      if (Math.abs(Math.atan2(a.x, a.z) - Math.atan2(b.x, b.z)) > 0.22) {
        // 弯外侧：切线叉乘侧向的符号决定哪一边是外侧
        const cross = samples[i].side.x * b.z - samples[i].side.z * b.x;
        const sign = cross > 0 ? -1 : 1;
        stacks.push({ s: samples[i], sign });
        i += 40; // 同一弯只放一簇
      }
    }
    const N_TIRE = stacks.length * 4;
    const tires = new THREE.InstancedMesh(tireGeo, tireMat, N_TIRE);
    const tiresW = new THREE.InstancedMesh(tireGeo, tireWhite, N_TIRE);
    let ti = 0, twi = 0;
    for (const { s, sign } of stacks) {
      const base = s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 2.6));
      for (let k = 0; k < 4; k++) {
        const px = base.x + (k % 2) * 0.95 * s.side.z, pz = base.z + (k % 2) * -0.95 * s.side.x;
        const py = 0.2 + Math.floor(k / 2) * 0.36;
        dummy.position.set(px, py, pz);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        if ((ti + twi) % 5 === 0) tiresW.setMatrixAt(twi++, dummy.matrix); // 白红相间的赛车轮胎墙
        else tires.setMatrixAt(ti++, dummy.matrix);
      }
    }
    tires.count = ti; tiresW.count = twi;
    tires.castShadow = true;
    scene.add(tires, tiresW);
  }

  // ---- 广告牌：环道外侧 4 块 + 高速 2 块 ----
  if (!skipProps) {
    const ads = [
      ['霓虹狂飙', 'NEON RUSH', '#14243c', '#7ee0ff'],
      ['漂移之王', 'DRIFT KING', '#3a1420', '#ff9a5c'],
      ['能量环收集赛', 'COLLECT 14', '#143a2c', '#7dffb0'],
      ['单圈计时挑战', 'TIME ATTACK', '#2c2c3a', '#ffd76a'],
      ['极速 300', 'SPEED ZONE', '#22283a', '#9ab8ff'],
      [' safer 驾驶', 'KEEP CALM', '#2a3a2a', '#b8e8a0'],
    ];
    const boardGeo = new THREE.BoxGeometry(7.5, 3.4, 0.25);
    const legGeo = new THREE.CylinderGeometry(0.16, 0.2, 4.2, 6);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.6, metalness: 0.5 });
    // 环道：均匀取 4 个样点外侧
    for (let k = 0; k < 4; k++) {
      const s = samples[Math.floor((k / 4 + 0.11) * samples.length) % samples.length];
      const sign = k % 2 ? 1 : -1;
      const p = s.pos.clone().addScaledVector(s.side, sign * (HALF_WIDTH + 6));
      const g2 = new THREE.Group();
      g2.add(new THREE.Mesh(legGeo, legMat));
      const tex = makeBillboardTexture(...ads[k]);
      const board = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.55, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.35,
      }));
      board.position.y = 5.6;
      board.castShadow = true;
      g2.add(board);
      g2.position.set(p.x, 2.1, p.z);
      g2.rotation.y = Math.atan2(s.tan.x, s.tan.z) + (sign > 0 ? -Math.PI / 2 : Math.PI / 2);
      scene.add(g2);
    }
    // 高速：2 块立在路侧
    for (let k = 0; k < 2; k++) {
      const s = world.highway.samples[Math.floor((0.3 + k * 0.4) * world.highway.samples.length)];
      const p = s.pos.clone().addScaledVector(s.side, (k % 2 ? 1 : -1) * 16);
      const g2 = new THREE.Group();
      g2.add(new THREE.Mesh(legGeo, legMat));
      const tex = makeBillboardTexture(...ads[4 + k]);
      const board = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.55, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.35,
      }));
      board.position.y = 5.6;
      board.castShadow = true;
      g2.add(board);
      g2.position.set(p.x, 2.1, p.z);
      g2.rotation.y = Math.atan2(s.tan.x, s.tan.z) + (k % 2 ? -Math.PI / 2 : Math.PI / 2);
      scene.add(g2);
    }
  }

  // ---- 看台：起点直道外侧（阶梯座席 + 条纹遮阳棚）----
  if (!skipProps) {
    const s0 = samples[40]; // 起点稍前方
    const standGroup = new THREE.Group();
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x50565e, roughness: 0.8 });
    const seatColors = [0xc23b3b, 0x2f6fc4, 0xe0b23a, 0x3fae6a, 0xd8dade];
    for (let tier = 0; tier < 5; tier++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(16, 0.8, 1.6), stepMat);
      step.position.set(0, 0.4 + tier * 0.8, tier * 1.5);
      step.castShadow = step.receiveShadow = true;
      standGroup.add(step);
      // 座席：随机彩色小方块
      const seats = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.5, 0.5, 0.5),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
        20
      );
      const cTmp = new THREE.Color();
      for (let k = 0; k < 20; k++) {
        dummy.position.set(-7.2 + k * 0.76, 1.0 + tier * 0.8, tier * 1.5);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        seats.setMatrixAt(k, dummy.matrix);
        cTmp.setHex(seatColors[(Math.random() * seatColors.length) | 0]);
        seats.setColorAt(k, cTmp);
      }
      seats.instanceColor.needsUpdate = true;
      standGroup.add(seats);
    }
    // 遮阳棚（斜面板）
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(17, 0.2, 10),
      new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.6, metalness: 0.3 })
    );
    roof.position.set(0, 6.4, 3.4);
    roof.rotation.x = 0.16;
    roof.castShadow = true;
    standGroup.add(roof);
    // 支柱
    for (const px of [-7.5, 7.5]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 6.6, 6), stepMat);
      pole.position.set(px, 3.3, 7.4);
      standGroup.add(pole);
    }
    const p0 = s0.pos.clone().addScaledVector(s0.side, HALF_WIDTH + 7);
    standGroup.position.set(p0.x, 0, p0.z);
    standGroup.rotation.y = Math.atan2(s0.tan.x, s0.tan.z) + Math.PI / 2;
    scene.add(standGroup);
  }

  // ---- 草簇与花丛：贴路散布，填充草地空旷感 ----
  {
    const N_TUFT = rich ? 2200 : 900;
    const tuftGeo = new THREE.PlaneGeometry(1.1, 0.8);
    const tuftTex = makeTuftTexture();
    const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshStandardMaterial({
      map: tuftTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
      roughness: 1, color: 0xffffff,
    }), N_TUFT * 2); // 每簇两片交叉
    const N_FLOWER = rich ? 500 : 200;
    const flowerGeo = new THREE.SphereGeometry(0.09, 5, 4);
    const flowers = new THREE.InstancedMesh(flowerGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), N_FLOWER);
    const fColors = [0xe85a6a, 0xf2c94c, 0xffffff, 0xcf8cf2, 0xf2925c];
    const cTmp = new THREE.Color();
    let tCount = 0, fCount = 0, tries2 = 0;
    while ((tCount < N_TUFT || fCount < N_FLOWER) && tries2 < 9000) {
      tries2++;
      const x = (Math.random() * 2 - 1) * 1400;
      const z = (Math.random() * 2 - 1) * 1400;
      const d = distToTrack(x, z);
      if (d < HALF_WIDTH + 1.5 || d > 60) continue; // 贴路 60m 范围带
      if (tCount < N_TUFT) {
        const sc = 0.7 + Math.random() * 1.1;
        for (let k = 0; k < 2; k++) {
          dummy.position.set(x, 0.35 * sc, z);
          dummy.scale.set(sc, sc, sc);
          dummy.rotation.set(0, Math.random() * Math.PI + k * Math.PI / 2, 0);
          dummy.updateMatrix();
          tufts.setMatrixAt(tCount * 2 + k, dummy.matrix);
        }
        tCount++;
      }
      if (fCount < N_FLOWER && Math.random() < 0.4) {
        dummy.position.set(x, 0.09, z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        flowers.setMatrixAt(fCount, dummy.matrix);
        cTmp.setHex(fColors[(Math.random() * fColors.length) | 0]);
        flowers.setColorAt(fCount, cTmp);
        fCount++;
      }
    }
    tufts.count = tCount * 2;
    flowers.count = fCount;
    flowers.instanceColor.needsUpdate = true;
    scene.add(tufts, flowers);
  }

  // ---- 高压电线：沿高速一侧成排（杆 + 连续导线）----
  if (!skipProps) {
    const hs = world.highway.samples;
    const poleSpots = [];
    for (let i = 0; i < hs.length; i += 34) {
      const s = hs[i];
      poleSpots.push(s.pos.clone().addScaledVector(s.side, 15).setY(0));
    }
    const pGeo = new THREE.CylinderGeometry(0.16, 0.24, 11, 6);
    const crossGeo = new THREE.BoxGeometry(2.6, 0.18, 0.18);
    const pMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.9 });
    const poles = new THREE.InstancedMesh(pGeo, pMat, poleSpots.length);
    const crosses = new THREE.InstancedMesh(crossGeo, pMat, poleSpots.length);
    poleSpots.forEach((p, k) => {
      dummy.position.set(p.x, 5.5, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      poles.setMatrixAt(k, dummy.matrix);
      dummy.position.set(p.x, 10.2, p.z);
      dummy.updateMatrix();
      crosses.setMatrixAt(k, dummy.matrix);
    });
    poles.castShadow = true;
    scene.add(poles, crosses);
    // 导线：相邻杆顶连线（三条平行线）
    const wireMat = new THREE.LineBasicMaterial({ color: 0x22262c });
    for (let w = -1; w <= 1; w++) {
      const pts = poleSpots.map((p, k) => {
        const s = hs[k * 34];
        const off = s.side.clone().multiplyScalar(w * 0.9);
        return new THREE.Vector3(p.x + off.x, 10.0, p.z + off.z);
      });
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
    }
  }

  // ---- 飞鸟群：三群绕圈盘旋 ----
  const birds = [];
  if (!skipProps) {
    const birdTex = makeBirdTexture();
    for (let g = 0; g < 3; g++) {
      const cx = (Math.random() * 2 - 1) * 700, cz = (Math.random() * 2 - 1) * 700;
      const cy = 55 + Math.random() * 60;
      const r = 40 + Math.random() * 50;
      const flock = [];
      for (let b = 0; b < 5; b++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: birdTex, transparent: true, depthWrite: false,
          color: 0x3a424c, fog: true,
        }));
        sp.scale.set(3.2, 1.6, 1);
        scene.add(sp);
        flock.push({ sp, phase: b * 0.9, r: r + (Math.random() - 0.5) * 14, y: cy + (Math.random() - 0.5) * 6 });
      }
      birds.push({ cx, cz, speed: 0.25 + Math.random() * 0.2, flock });
    }
  }

  // ---- 每帧动画（风机叶片 / 飞鸟盘旋）----
  let birdT = 0;
  function update(dt) {
    for (const r of rotors) r.rotation.z += dt * r.userData.speed;
    birdT += dt;
    for (const flock of birds) {
      for (const b of flock.flock) {
        const a = birdT * flock.speed + b.phase;
        b.sp.position.set(
          flock.cx + Math.cos(a) * b.r,
          b.y + Math.sin(birdT * 0.7 + b.phase) * 2.2,
          flock.cz + Math.sin(a) * b.r
        );
        b.sp.material.rotation = Math.sin(birdT * 6 + b.phase) * 0.35; // 扑翼感
      }
    }
  }

  return { ground, railGroup, update };
}
