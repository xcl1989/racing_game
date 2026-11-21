// scenery.js — 大地图装饰：起伏草地/团簇树/岩石/白天质感楼房/雾蓝远山/
// 风力发电机/连续护栏（比赛限定显示）/路灯/广告牌/轮胎墙/看台/草簇/花丛/电线杆/飞鸟
import * as THREE from 'three';
import {
  makeGrassTexture, makeWaterNormal, makeTuftTexture,
  makeBillboardTexture, makeBirdTexture, makeFieldTexture,
} from './textures.js';
import { addMirrorLakePlanting, ageMirrorLakePaint, shadeMirrorLake } from './lake-detail.js';
import { firCrown } from './scene-detail.js';
import { addSurfaceFinish, terrainTint } from './world-surface-finish.js';
import { addRegionScenery } from './region-scenery.js';
import { LAKE } from './world-guide.js';
import { HALF_WIDTH } from './track.js';
import { makeWaterMaterial, updateWater } from './water.js'; // v2.24 水面材质升级
import { makeFoliageTexture } from './textures.js';           // v2.25 叶丛斑驳贴图
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'; // v2.25 树冠平滑

export function buildScenery(scene, track, world, rich = true) {
  // rich=false（手机低配）：植被减量、跳过装饰性 Props
  const D = rich ? 1 : 0.55;      // 植被密度系数
  const skipProps = !rich;
  const samples = track.samples;
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  // 山地高度场（world.groundSampler 与渲染面同源：山框内=21m 山面网格、框外=5200 平面三角插值）：
  // 所有植被/岩石按地形贴地，山区不种田不立风机
  const TH = world.groundSampler || world.sampleTerrain || world.terrainH || (() => 0);

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

  // ---- 地面：位移网格（山体隆起 + 河道/湖盆下切成形）+ 顶点色 + 草地纹理 ----
  // v2.12：由平盘圆面改为 120x120 位移网格，直接采样 world.terrainH（含水文下切）
  const groundGeo = new THREE.PlaneGeometry(5200, 5200, 120, 120);
  groundGeo.rotateX(-Math.PI / 2); // 本地 (x,y) → 世界 (x,z)
  {
    const pos = groundGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = world.sampleTerrain(x, z); // 与物理 heightAt 同源（烘焙双线性），地形/车/植被四方一致
      pos.setY(i, h); // 山体隆起 + 河湖下切（与物理同一函数）
      const slope = Math.hypot(TH(x+22,z)-TH(x-22,z), TH(x,z+22)-TH(x,z-22)) / 44;
      terrainTint(x,z,h,slope,tmpColor).toArray(colors,i*3);
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
    map: makeGrassTexture(170), // 平铺更密：34m/格，防手机端马赛克感
    vertexColors: true,
    roughness: 1, metalness: 0,
  }));
  ground.receiveShadow = true;
  shadeMirrorLake(ground.material, world.westLake);
  addSurfaceFinish(ground.material, 'terrain');
  scene.add(ground);
  ageMirrorLakePaint(world.westLake.mesh.material);

  // ---- 湖（盆地下切后的水面：低于地面 1.5m，盆缘 136-146 收紧成陡岸）----
  // 新位置 (660,-560)；world.js 湖滨路环岛与湖东野径按此坐标衔接（野径 d≥145 贴岸顶）
  // v2.24 换 water.js 材质（顶点波浪/菲涅尔/泡沫）；方形细分网格承载波浪，水线由地形反推 d≈136
  const lakePos = LAKE;
  if (distToTrack(lakePos.x, lakePos.z) > 120) {
    const lakeNormal = makeWaterNormal();
    lakeNormal.repeat.set(23, 23); // ~14m/格
    const lake = new THREE.Mesh(
      new THREE.PlaneGeometry(330, 330, 64, 64),
      makeWaterMaterial({
        deep: 0x164859, shallow: 0x4b7a71, foam: .28, glint: .73,
        shoreMode: 'circle', center: [lakePos.x, lakePos.z], shoreR: lakePos.r,
        band: 26, foamBand: 3.5, waveAmp: 0.06,
        normalTex: lakeNormal, normalScale: 0.4, repeat: 23,
      })
    );
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(lakePos.x, -1.5, lakePos.z);
    scene.add(lake);

    // 湖畔木栈桥（从东北岸伸向湖心：架高板道 + 长桩入水触底）
    const woodMat = addSurfaceFinish(new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: .90 }), 'bark');
    const pier = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.22, 62), woodMat);
    deck.position.set(0, 0.75, 0);
    deck.castShadow = true;
    pier.add(deck);
    for (let k = 0; k < 8; k++) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.6, 6), woodMat);
        post.position.set(s * 1.1, 0.15, -28 + k * 8);
        pier.add(post);
      }
    }
    // 栈桥方向：从湖岸指向湖心（湖心→环岛方向的反向）
    const dirX = 820 - lakePos.x, dirZ = -420 - lakePos.z;
    const dl = Math.hypot(dirX, dirZ);
    const ux = dirX / dl, uz = dirZ / dl;
    const shoreX = lakePos.x + ux * (lakePos.r + 2), shoreZ = lakePos.z + uz * (lakePos.r + 2);
    pier.position.set(shoreX + ux * 30, -0.55, shoreZ + uz * 30);
    // 组 y=-0.55：岸端板面 ≈ +0.2 齐地面，水上端悬于水面 1.7m 的架高板道
    pier.rotation.y = Math.atan2(ux, uz); // 长轴(+Z)沿伸入湖心的方向
    scene.add(pier);

    // 湖上小船两叶（浮于 -1.5 水面）
    const boatMat = new THREE.MeshStandardMaterial({ color: 0xd8dfe4, roughness: 0.6 });
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x4a6a8a, roughness: 0.5, metalness: 0.3 });
    for (const [bx, bz, ba] of [[720, -510, 0.6], [610, -610, 2.4]]) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 5), hullMat);
      hull.position.y = 0.1;
      boat.add(hull);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 2.4), boatMat);
      cabin.position.set(0, 0.75, 0.4);
      boat.add(cabin);
      boat.position.set(bx, -1.25, bz);
      boat.rotation.y = ba;
      scene.add(boat);
    }

    // 湖畔农舍三栋（红墙白窗 + 坡顶，散在环岛西侧的坡地上）
    const wallMat = addSurfaceFinish(new THREE.MeshStandardMaterial({ color: 0xa24d39, roughness: .90 }), 'stone');
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a3f38, roughness: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x88a8c0, roughness: 0.2, metalness: 0.6, envMapIntensity: 1.2,
    });
    for (const [cx, cz, rot] of [[868, -368, 0.5], [888, -452, -0.9], [852, -478, 2.2]]) {
      const house = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 7), wallMat);
      const stone = new THREE.Mesh(new THREE.BoxGeometry(9.12,0.55,7.12), new THREE.MeshStandardMaterial({color:0x81776a,roughness:.93}));
      stone.position.y = .28;
      house.add(stone);
      body.position.y = 2.1;
      body.castShadow = true;
      house.add(body);
      // Extruded gable and two sloping eaves, not a pyramid perched on a box.
      const gable = new THREE.Shape();
      gable.moveTo(-4.85,4.14); gable.lineTo(4.85,4.14); gable.lineTo(0,6.65); gable.closePath();
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(gable,{depth:7.7,bevelEnabled:false}),roofMat);
      roof.position.z = -3.85;
      roof.castShadow = true;
      house.add(roof);
      const frameMat = new THREE.MeshStandardMaterial({color:0xb9b2a3,roughness:.82});
      const doorMat = new THREE.MeshStandardMaterial({color:0x453e35,roughness:.93});
      for (const side of [-1,1]) for (const wx of [-2.65,2.65]) {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(1.58,1.42,.16),frameMat);
        frame.position.set(wx,2.30,side*3.53);
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.30,1.14,.07),glassMat);
        win.position.set(wx,2.30,side*3.64);
        house.add(frame,win);
      }
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.20,2.16,.16),doorMat);
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(.65,2.0,.74),wallMat);
      door.position.set(0,1.17,3.57);
      chimney.position.set(2.0,5.88,-1.45);
      house.add(door,chimney);
      house.position.set(cx, 0, cz);
      house.rotation.y = rot;
      scene.add(house);
    }
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

  // 展示台清场（v2.14）：赛道内圈选车展厅展示点 (0,-100) 半径 16m 内不生成任何地物，
  // 否则环绕相机会周期性被树干/岩石穿模遮挡
  const inShowroom = (x, z) => Math.hypot(x, z + 100) < 40;

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
    if (d < HALF_WIDTH + 4 || d > 300 || TH(x, z) < -0.4 || inShowroom(x, z)) continue; // 不下水
    const sc = 0.35 + Math.random() * 0.7;
    const th = TH(x, z);
    dummy.position.set(x, sc * 0.55 + th, z);
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

  // ---- 树：双树种（v2.23）——阔叶（干+4椭球冠）70% / 针叶（干+3层锥冠）30% ----
  // 剪影多样性是植被观感的第一要素：满屏同形椭球 = "贴图树"，混入锥形针叶立刻像林子
  // v2.25 冠团重制：皱缩噪声八面体球（去光滑圆球感）+ 每棵树随机 4 团布局（破对称棒棒糖）
  const N_TREE = Math.round(650 * D);
  // 皱缩叶冠几何：顶点按确定性噪声径向扰动，mergeVertices 后平滑法线
  // （PolyhedronGeometry 是非索引几何，同位置顶点噪声值相同 → 扰动不撕裂；再平滑法线去面片感）
  function lumpyLeaf() {
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 2), 1e-4);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 3.1 + 1.2) * Math.sin(v.y * 2.7 + 3.4) * Math.sin(v.z * 3.3 + 1.1)
        + 0.5 * Math.sin(v.x * 5.7 + v.z * 4.9)
        + 0.35 * Math.sin(v.y * 7.3 - v.x * 2.1);
      const m = 1 + 0.30 * n;
      p.setXYZ(i, v.x * m, v.y * m * 0.9, v.z * m);
    }
    g.computeVertexNormals();
    return g;
  }
  const leafGeo = lumpyLeaf();
  const foliageTex = makeFoliageTexture();
  addMirrorLakePlanting(scene, world, rich, foliageTex);
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.27, 2.6, 7, 3);
  const barkPos = trunkGeo.attributes.position;
  for (let i = 0; i < barkPos.count; i++) {
    const y = barkPos.getY(i);
    barkPos.setX(i, barkPos.getX(i) + 0.09 * Math.sin((y + 1.3) * 0.9));
  }
  trunkGeo.computeVertexNormals();
  const trunkMat = addSurfaceFinish(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), 'bark');
  const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, N_TREE); // v2.13 instanceColor 染干
  const canopy = new THREE.InstancedMesh(leafGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, map: foliageTex }), N_TREE * 4);
  // v2.23 针叶树实例集
  const pineTrunk = new THREE.InstancedMesh(trunkGeo, trunkMat, N_TREE);
  const coneGeo = firCrown();
  const conifer = new THREE.InstancedMesh(coneGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, vertexColors: true }), N_TREE * 3);
  trunk.castShadow = canopy.castShadow = pineTrunk.castShadow = conifer.castShadow = true;
  const pineLayers = [[2.4, 1.7, 1.6], [3.5, 1.3, 1.4], [4.4, 0.85, 1.2]]; // [底y, 半径, 层高]
  // v2.25 每棵树随机冠团布局：1 大顶团 + 3 侧团（随机方位/半径/高度/尺寸）
  function makeBlobLayout() {
    const blobs = [[0, 3.5 + Math.random() * 0.3, 0, 1.3 + Math.random() * 0.3]];
    const a0 = Math.random() * Math.PI * 2;
    const sideN = 3;
    for (let b = 0; b < sideN; b++) {
      const a = a0 + (b / sideN) * Math.PI * 2 + (Math.random() - 0.5) * 1.0;
      const r = 0.83 + Math.random() * 0.53;
      blobs.push([
        Math.cos(a) * r,
        2.6 + Math.random() * 1.3,
        Math.sin(a) * r,
        0.75 + Math.random() * 0.4,
      ]);
    }
    return blobs;
  }
  placed = 0; tries = 0;
  let pineN = 0;
  while (placed + pineN < N_TREE && tries < 5000) {
    tries++;
    const x = (Math.random() * 2 - 1) * 1500;
    const z = (Math.random() * 2 - 1) * 1500;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 7 || d > 500 || TH(x, z) < -0.4 || inShowroom(x, z)) continue; // 不下水/展厅清场
    const sc = 0.8 + Math.random() * 1.5;
    const th = TH(x, z);
    const isPine = Math.random() < 0.3;
    dummy.position.set(x, 1.3 * sc + th, z);
    dummy.scale.set(sc, sc, sc);
    dummy.rotation.y = Math.random() * Math.PI;
    dummy.updateMatrix();
    // v2.13 树干色差：灰褐→红褐随机
    const tb = 0.75 + Math.random() * 0.5;
    tmpColor.setRGB(0.42 * tb, 0.30 * tb, 0.21 * tb);
    if (isPine) {
      pineTrunk.setMatrixAt(pineN, dummy.matrix);
      pineTrunk.setColorAt(pineN, tmpColor);
      // 锥冠三层（针叶更深更冷，山顶林感的深绿）+ v2.25 层间随机抖动
      for (let b = 0; b < 3; b++) {
        const [cy, cr, chh] = pineLayers[b];
        const jr = cr * (0.85 + Math.random() * 0.3);   // 半径抖动
        const jh = chh * (0.9 + Math.random() * 0.25);  // 层高抖动
        dummy.position.set(
          x + (Math.random() - 0.5) * 0.2 * sc,
          (cy + jh / 2) * sc + th,
          z + (Math.random() - 0.5) * 0.2 * sc
        );
        dummy.scale.set(jr * sc, jh * sc, jr * sc);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.updateMatrix();
        const idx = pineN * 3 + b;
        conifer.setMatrixAt(idx, dummy.matrix);
        const tint = 0.55 + Math.random() * 0.35;
        tmpColor.setRGB(0.16 * tint, 0.34 * tint, 0.20 * tint);
        conifer.setColorAt(idx, tmpColor);
      }
      pineN++;
    } else {
      trunk.setMatrixAt(placed, dummy.matrix);
      trunk.setColorAt(placed, tmpColor);
      const blobs = makeBlobLayout();
      for (let b = 0; b < blobs.length; b++) {
        const [ox, oy, oz, bs] = blobs[b];
        dummy.position.set(x + ox * sc, oy * sc + th, z + oz * sc);
        dummy.scale.set(bs * sc, bs * sc * (0.66 + 0.14 * b), bs * sc);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.updateMatrix();
        const idx = placed * 4 + b;
        canopy.setMatrixAt(idx, dummy.matrix);
        // v2.13 树冠色域拉宽：明度 + 色相双向抖动（暖黄绿 ↔ 深冷绿，Forza 植被的杂生感）
        // v2.25 整体提亮一档（叶丛贴图有暗斑，叠加后偏墨绿）
        const tint = 0.68 + Math.random() * 0.62;
        const hueR = (Math.random() - 0.5) * 0.10;  // 暖端：叶绿素衰变泛黄
        const hueB = (Math.random() - 0.5) * 0.06;  // 冷端：偏蓝的深绿
        tmpColor.setRGB(
          Math.max(0.05, 0.27 * tint + hueR),
          Math.max(0.1, 0.50 * tint),
          Math.max(0.05, 0.25 * tint + hueB)
        );
        canopy.setColorAt(idx, tmpColor);
      }
      placed++;
    }
  }
  trunk.count = placed;
  canopy.count = placed * 4;
  pineTrunk.count = pineN;
  conifer.count = pineN * 3;
  trunk.instanceColor.needsUpdate = true;
  canopy.instanceColor.needsUpdate = true;
  pineTrunk.instanceColor.needsUpdate = true;
  conifer.instanceColor.needsUpdate = true;
  scene.add(trunk, canopy, pineTrunk, conifer);

  // ---- 岩石 ----
  const N_ROCK = Math.round(230 * D);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo,
    addSurfaceFinish(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95, flatShading: true }), 'stone'), N_ROCK);
  placed = 0; tries = 0;
  while (placed < N_ROCK && tries < 3000) {
    tries++;
    const x = (Math.random() * 2 - 1) * 1400;
    const z = (Math.random() * 2 - 1) * 1400;
    const d = distToTrack(x, z);
    if (d < HALF_WIDTH + 5 || d > 350 || TH(x, z) < -0.4 || inShowroom(x, z)) continue; // 不下水/展厅清场
    const sc = 0.4 + Math.random() * 1.8;
    dummy.position.set(x, sc * 0.35 + TH(x, z), z);
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

  // ---- 农田色块：麦田/青苗/耕地的大矩形（打破草地一整片绿的空旷感）----
  if (!skipProps) {
    const fieldGeo = new THREE.PlaneGeometry(1, 1);
    fieldGeo.rotateX(-Math.PI / 2);
    const fields = new THREE.InstancedMesh(fieldGeo, new THREE.MeshStandardMaterial({
      map: makeFieldTexture(), roughness: 1, metalness: 0,
    }), 14);
    const fTints = [
      [0.86, 0.72, 0.35],  // 麦黄
      [0.42, 0.62, 0.30],  // 青苗
      [0.55, 0.42, 0.28],  // 犁过的棕壤
      [0.90, 0.82, 0.30],  // 油菜花黄
    ];
    const FIELD_TINTS = fTints.map((c) => tmpColor.setRGB(...c).clone());
    let fPlaced = 0, fTries = 0;
    while (fPlaced < 14 && fTries < 3000) {
      fTries++;
      const x = (Math.random() * 2 - 1) * 1400;
      const z = (Math.random() * 2 - 1) * 1400;
      // 避开道路（distToRoads 已含高速/乡道/城市/湖滨路/国道/山道）与城市街区、湖、山
      if (world.distToRoads(x, z) < 34) continue;
      if (TH(x, z) > 1.5 || TH(x, z) < -0.4) continue; // 不上山不下水
      if (x > 760 && x < 1350 && z > 40 && z < 660) continue;      // 城市范围
      if (Math.hypot(x - 660, z + 560) < 190) continue;            // 湖
      if (distToTrack(x, z) < 30) continue;
      const w = 70 + Math.random() * 110;
      const th = TH(x, z);
      dummy.position.set(x, 0.06 + th, z); // 抬 6cm 防远距 Z-fighting
      dummy.scale.set(w, 1, w * (0.6 + Math.random() * 0.6));
      dummy.rotation.set(0, Math.random() * Math.PI, 0);
      dummy.updateMatrix();
      fields.setMatrixAt(fPlaced, dummy.matrix);
      tmpColor.copy(FIELD_TINTS[(Math.random() * FIELD_TINTS.length) | 0]);
      tmpColor.multiplyScalar(0.85 + Math.random() * 0.3);
      fields.setColorAt(fPlaced, tmpColor);
      fPlaced++;
    }
    fields.count = fPlaced;
    fields.instanceColor.needsUpdate = true;
    fields.receiveShadow = true;
    scene.add(fields);
  }

  // ---- 松林团簇：三片针叶林（远看深绿一坨，近看锥形塔冠，补荒野层次）----
  if (!skipProps) {
    const GROVES = [[-350, -650], [-150, -950], [250, 900]];
    const N_PINE = 46;
    const pineTrunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 3.4, 6);
    const pineConeGeo = firCrown().scale(3.2,13,3.2);
    const trunks = new THREE.InstancedMesh(pineTrunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x4a3628, roughness: 1 }), N_PINE * GROVES.length);
    const crowns = new THREE.InstancedMesh(pineConeGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, vertexColors: true }), N_PINE * GROVES.length);
    trunks.castShadow = crowns.castShadow = true;
    let pi = 0, pTries = 0;
    for (const [gx, gz] of GROVES) {
      let inGrove = 0;
      while (inGrove < N_PINE && pTries < 5000) {
        pTries++;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 130;
        const x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r;
        if (distToTrack(x, z) < HALF_WIDTH + 10) continue;
        if (TH(x, z) > 1.5 || TH(x, z) < -0.4) continue; // 不上山不下水
        const sc = 0.7 + Math.random() * 0.9;
        const th = TH(x, z);
        dummy.position.set(x, 1.7 * sc + th, z);
        dummy.scale.set(sc, sc, sc);
        dummy.rotation.set(0, Math.random() * Math.PI, 0);
        dummy.updateMatrix();
        trunks.setMatrixAt(pi, dummy.matrix);
        dummy.position.set(x, (3.4 + 6.2) * sc + th, z);
        dummy.updateMatrix();
        crowns.setMatrixAt(pi, dummy.matrix);
        const t = 0.7 + Math.random() * 0.5;
        tmpColor.setRGB(0.16 * t, 0.33 * t, 0.19 * t);
        crowns.setColorAt(pi, tmpColor);
        pi++; inGrove++;
      }
    }
    trunks.count = crowns.count = pi;
    crowns.instanceColor.needsUpdate = true;
    scene.add(trunks, crowns);
  }

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
    if (TH(x, z) > 1.5 || TH(x, z) < -0.4) continue; // 不上山水
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
  const storefrontObstacles = [];
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
        for (const side of [-1, 1]) {
          const x = px + side * ox, z = pz + side * oz;
          if (!world.isOnCityRoad({ x, z })) spots.push(new THREE.Vector3(x, 0, z));
        }
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
    storefrontObstacles.push(lamps, heads);
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

  // ---- 行道树（v2.13）：城市街道 + 湖滨路/北大道/湖西环路两侧成排（Forza 街景标配）----
  if (!skipProps) {
    const tTrunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 7);
    const spots = [];
    for (const st of world.cityStreets) {
      const dx = st.bx - st.ax, dz = st.bz - st.az;
      const len = Math.hypot(dx, dz);
      const n = Math.floor(len / 48);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const px = st.ax + dx * t, pz = st.az + dz * t;
        const ox = (-dz / len) * (st.width / 2 + 3.2);
        const oz = (dx / len) * (st.width / 2 + 3.2);
        spots.push([px + ox, pz + oz], [px - ox, pz - oz]);
      }
    }
    const lakeApproach = world.lakeRoad.samples;
    for (let i = 6; i < lakeApproach.length - 6; i += 16) {
      const s = lakeApproach[i];
      for (const sign of [1, -1]) {
        const p = s.pos.clone().addScaledVector(s.side, sign * 7.5);
        spots.push([p.x, p.z]);
      }
    }
    const N_ST = spots.length;
    const stTrunk = new THREE.InstancedMesh(tTrunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x54402e, roughness: 1 }), N_ST);
    const stCanopy = new THREE.InstancedMesh(leafGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, map: foliageTex }), N_ST * 3);
    stTrunk.castShadow = stCanopy.castShadow = true;
    let si = 0, sci = 0;
    for (const [px, pz] of spots) {
      const th = TH(px, pz);
      const pos = { x: px, z: pz };
      if (th < -0.4 || world.onAnyRoad(pos)) continue;
      if (world.bldColliders.some(({ x, z, hw, hd }) => Math.abs(px - x) < hw + 1.2 && Math.abs(pz - z) < hd + 1.2)) continue;
      const sc = 0.75 + Math.random() * 0.55;
      dummy.position.set(px, 1.2 * sc + th, pz);
      dummy.scale.set(sc, sc, sc);
      dummy.rotation.y = Math.random() * Math.PI;
      dummy.updateMatrix();
      stTrunk.setMatrixAt(si, dummy.matrix);
      // v2.25 三团冠：顶部大团 + 两侧随机小团（随机方位/尺寸，去"双球棒棒糖"）
      const stBlobs = [[0, 2.95, 0, 1.2 + Math.random() * 0.2]];
      const sa0 = Math.random() * Math.PI * 2;
      for (let b = 0; b < 2; b++) {
        const sa = sa0 + b * Math.PI + (Math.random() - 0.5) * 1.2;
        stBlobs.push([
          Math.cos(sa) * (0.5 + Math.random() * 0.3),
          2.35 + Math.random() * 0.7,
          Math.sin(sa) * (0.5 + Math.random() * 0.3),
          0.65 + Math.random() * 0.3,
        ]);
      }
      for (let b = 0; b < stBlobs.length; b++) {
        const [ox, oy, oz, bs] = stBlobs[b];
        dummy.position.set(px + ox * sc, oy * sc + th, pz + oz * sc);
        dummy.scale.set(bs * sc, bs * sc * (0.66 + 0.14 * b), bs * sc);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.updateMatrix();
        const t = 0.8 + Math.random() * 0.45;
        tmpColor.setRGB(0.25 * t, 0.5 * t, 0.23 * t);
        stCanopy.setMatrixAt(sci, dummy.matrix);
        stCanopy.setColorAt(sci, tmpColor);
        sci++;
      }
      si++;
    }
    stTrunk.count = si; stCanopy.count = sci;
    if (stCanopy.instanceColor) stCanopy.instanceColor.needsUpdate = true;
    scene.add(stTrunk, stCanopy);
    storefrontObstacles.push(stTrunk, stCanopy);
  }

  // ---- 干草垛（v2.13）：田野横放草卷，乡村感（Forza 英国地景标志性物件）----
  if (!skipProps) {
    const N_HAY = 26;
    const hayGeo = new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10);
    hayGeo.rotateZ(Math.PI / 2); // 横放
    const hays = new THREE.InstancedMesh(hayGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), N_HAY);
    let hi = 0, hTries = 0;
    while (hi < N_HAY && hTries < 3000) {
      hTries++;
      const x = (Math.random() * 2 - 1) * 1400;
      const z = (Math.random() * 2 - 1) * 1400;
      if (world.distToRoads(x, z) < 26 || distToTrack(x, z) < 24 || inShowroom(x, z)) continue;
      if (TH(x, z) > 1.5 || TH(x, z) < -0.4) continue;
      if (x > 760 && x < 1350 && z > 40 && z < 660) continue;      // 城市范围
      if (Math.hypot(x - 660, z + 560) < 190) continue;            // 湖
      const th = TH(x, z);
      dummy.position.set(x, 0.9 + th, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.y = Math.random() * Math.PI;
      dummy.updateMatrix();
      const t = 0.85 + Math.random() * 0.3;
      tmpColor.setRGB(0.78 * t, 0.66 * t, 0.34 * t);
      hays.setColorAt(hi, tmpColor);
      hays.setMatrixAt(hi, dummy.matrix);
      hi++;
    }
    hays.count = hi;
    hays.instanceColor.needsUpdate = true;
    hays.castShadow = true;
    scene.add(hays);
  }

  // ---- 加油站（v2.13）：高速东南段旁（Forza 公路地标）----
  if (!skipProps) {
    const gas = new THREE.Group();
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xd8443a, roughness: 0.55, metalness: 0.25 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xb8bdc4, roughness: 0.4, metalness: 0.7 });
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0xe8e9ec, roughness: 0.5, metalness: 0.4 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5, 12), canopyMat);
    deck.position.y = 5.4; deck.castShadow = true;
    gas.add(deck);
    for (const cx of [-9, 9]) {
      for (const cz of [-4.6, 4.6]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 5.4, 8), steelMat);
        col.position.set(cx, 2.7, cz);
        gas.add(col);
      }
    }
    for (const px of [-3, 3]) {
      const pump = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.7, 2.2), pumpMat);
      pump.position.set(px, 0.85, 0);
      pump.castShadow = true;
      gas.add(pump);
      const hose = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 6, 12), steelMat);
      hose.position.set(px + 0.6, 1.2, 0);
      gas.add(hose);
    }
    // 立牌：发光价牌（远处可见）
    const sign = new THREE.Mesh(new THREE.BoxGeometry(5.6, 7.5, 0.5), steelMat);
    sign.position.set(0, 3.75, -9);
    sign.castShadow = true;
    gas.add(sign);
    const board = new THREE.Mesh(new THREE.BoxGeometry(4.6, 4.2, 0.2),
      new THREE.MeshStandardMaterial({
        color: 0xd8443a, roughness: 0.5,
        emissive: 0xff5544, emissiveIntensity: 0.28,
      }));
    board.position.set(0, 4.6, -9 + 0.36);
    gas.add(board);
    // 落位：高速东南段样条外侧（t≈0.86 → 东南象限，离城市楼群远、玩家东南向必经）
    const hs = world.highway.samples;
    const s0 = hs[Math.floor(0.86 * hs.length)];
    const gp = s0.pos.clone().addScaledVector(s0.side, 26);
    gas.position.set(gp.x, TH(gp.x, gp.z), gp.z);
    gas.rotation.y = Math.atan2(s0.tan.x, s0.tan.z) + Math.PI / 2;
    scene.add(gas);
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
      if (d < HALF_WIDTH + 1.5 || d > 60 || TH(x, z) < -0.4) continue; // 贴路 60m 范围带，不下水
      const th = TH(x, z);
      if (tCount < N_TUFT) {
        const sc = 0.7 + Math.random() * 1.1;
        for (let k = 0; k < 2; k++) {
          dummy.position.set(x, 0.35 * sc + th, z);
          dummy.scale.set(sc, sc, sc);
          dummy.rotation.set(0, Math.random() * Math.PI + k * Math.PI / 2, 0);
          dummy.updateMatrix();
          tufts.setMatrixAt(tCount * 2 + k, dummy.matrix);
        }
        tCount++;
      }
      if (fCount < N_FLOWER && Math.random() < 0.4) {
        dummy.position.set(x, 0.09 + th, z);
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
  addRegionScenery(scene, track, world, rich);

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

  return { ground, railGroup, update, storefrontObstacles };
}
