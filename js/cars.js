// cars.js — 车辆目录与程序化车模（v2.7 重制）
// 做法：沿车长方向放置一系列超椭圆横截面（宽度/下沿/上沿逐站平滑变化），
// 放样(loft)成连续曲面车身 —— 曲率连续的侧面和肩线，配合 clearcoat 清漆
// 才有金属漆的车感；玻璃舱独立放样，轮拱/侧裙/扩散器/灯组做体积细节。
import * as THREE from 'three';

// ---- 车辆目录（顺序即选择界面顺序）----
export const CAR_SPECS = [
  // ★ v2.20 全谱系重调：
  //   极速整体上调到 187~252km/h（铺装上 topSpeed 精确生效），车距明显拉开；
  //   新增 offroad 越野评级（0=纯跑车铺装专用 → 1=越野王）：
  //   决定草地/土路掉速——跑车在草地极速只剩 45%，越野王保留 83%
  {
    id: 'ferrari', name: 'Ferrari 458', cn: '法拉利 458', tone: '深红 · V8 均衡王者',
    color: 0x8f1420, useGLB: true,
    topSpeed: 62,  // m/s ≈ 223km/h
    accel: 30,
    brake: 34,
    grip: 1.04,
    offroad: 0,
    price: 1000,   // 💎 v2.32 车店定价（现实 ~400 万+ → 镇店之宝，区间上限）
  },
  {
    id: 'tesla', name: 'Tesla Model S', cn: '特斯拉 Model S', tone: '珍珠白 · 电动猛兽',
    color: 0xf4f6f8, useGLB: true,  // 真车模：models/tesla.glb（简化的 Sketchfab 实测扫描级模型）
    topSpeed: 57,   // ≈205km/h：车重极速不冒尖，起步猛
    accel: 41,
    brake: 29,
    grip: 0.88,
    offroad: 0.1,
    price: 220,    // 现实 ~70 万
  },
  {
    id: 'porsche', name: 'Porsche 911', cn: '保时捷 911', tone: '竞速黄 · 弯道手术刀',
    color: 0xf0a80a, useGLB: true,  // 真车模：models/porsche.glb（991 车型，轮子已拆分可独立滚动）
    topSpeed: 63,   // ≈227km/h
    accel: 31,
    brake: 38,      // 全库最强制动
    grip: 1.16,     // 全库最贴弯
    offroad: 0,
    price: 460,    // 现实 ~150 万

  },
  // ---- v2.16 新增三台真车模（GitHub 公开资源，轮子原生分件）----
  {
    id: 'su7', name: 'Xiaomi SU7 Max', cn: '小米 SU7 Max', tone: '海湾蓝 · 电驱新锐',
    color: 0x2f5f7d, useGLB: true,  // models/sus7_max.glb：四轮已分件（3DWheel Front/Rear L/R）
    topSpeed: 60,   // ≈216km/h
    accel: 42,      // 电驱起步最猛
    brake: 31,
    grip: 1.04,
    offroad: 0.1,
    price: 120,    // 现实 ~25 万 → 入门电动（全区间最低价）

  },
  {
    id: 'g63', name: 'Mercedes-AMG G63', cn: '奔驰 AMG G63', tone: '曜岩黑 · 方盒子猛兽',
    color: 0x24282d, useGLB: true,  // models/g63.glb：四轮已分件，车身重、高重心
    // 轮辋被拆成 14 个 polySurface 辐条/圈片（每片 bbox 中心离轮轴 0.19~0.33m），
    // 按几何面内偏心规则会被误判静件 → 显式声明这些件属于轮辋、强制滚动
    wheelRoll: /polySurface|Wheel1A/i,
    topSpeed: 53,   // ≈191km/h：车重风阻大，铺装极速倒数
    accel: 26,
    brake: 31,
    grip: 0.90,     // 高重心转向钝
    offroad: 0.8,   // 非铺装路面第二强（越野方盒子）
    price: 640,    // 现实 ~240 万（奢侈税）
  },
  {
    id: 'concept', name: 'Khronos Concept', cn: 'Khronos 概念车', tone: '霜银 · 未来主义实验体',
    color: 0xc9d3dd, useGLB: true,  // models/concept.glb：Khronos 官方 CC0，轮命名 WheelFrontL/Rim…
    // 轮辋由 Rim1/Rim2 两个半壳组成，其中一个半壳 bbox 中心偏 0.11m 被误判静件（前轮判反）
    wheelRoll: /Rim1|Rim2/i,
    topSpeed: 66,   // ≈238km/h
    accel: 33,
    brake: 34,
    grip: 1.10,
    offroad: 0,
    price: 760,    // 概念车（虚构稀缺）· 全库极速榜首
  },
  // ---- v2.16.1 二批：管线加工后接入 ----
  {
    id: 'm4', name: 'BMW M4', cn: '宝马 M4', tone: '竞速蓝 · 直线悍将',
    color: 0x1b4fae, useGLB: true,  // models/bmw_m4_opt.glb：四轮合并单 mesh → tools_split_wheels_quad 拆分
    topSpeed: 64,   // ≈230km/h：直线极速第二，仅次于 SU7 Ultra
    accel: 32,
    brake: 35,
    grip: 1.10,
    offroad: 0,
    price: 340,    // 现实 ~90 万

  },
  // ---- v2.19 新车：Sketchfab recycled 系直上（与 SU7/G63 同构，3DWheel 分件）----
  {
    id: 'm2g87', name: 'BMW M2 (G87)', cn: '宝马 M2', tone: '烈焰橙 · 纽北小钢炮',
    color: 0xc2621a, useGLB: true,  // models/sedan_main.glb：26 万面 Draco；材质 Paint/Window 可换漆
    // 轮辋为 polySurface 辐条群 + Wheel1A 命名（与 G63 同款），spec.wheelRoll 显式声明强制滚动
    wheelRoll: /polySurface|Wheel1A/i,
    topSpeed: 61,   // ≈220km/h：实车 460 马力
    accel: 33,
    brake: 35,
    grip: 1.09,     // 小钢炮贴弯
    offroad: 0,
    price: 280,    // 现实 ~60 万

  },
  // ---- v2.20 三台新车（raw 直连下载 → tools_simplify 简化 → 直上）----
  {
    id: 'jeep392', name: 'Jeep Wrangler 392', cn: 'Jeep 牧马人 Rubicon 392', tone: '岩湖蓝 · 硬派越野图腾',
    color: 0x2e6fc0, useGLB: true,  // models/jeep_wrangler_392_opt.glb：36.8万面→16.6万面；Ani_Wheel 分件
    // 轮命名交叉错位（BL/BR 件在前轴、FL/FR 在后轴），每轮由 Wheel_* 子树 + Disc_* 子树组成；
    // Disc 子树曾被中位数 hub 误判静件成空轮组 → wheelRoll 强制 Wheel/Disc 件滚动（卡钳含 brake 字样仍静件）
    wheelRoll: /Ani_Wheel|Ani_Disc/i,
    // 方盒子高重心：铺装极速垫底档、转向最钝；但草地/土路掉速全库最少
    topSpeed: 52,   // ≈187km/h
    accel: 27,
    brake: 30,
    grip: 0.86,
    offroad: 1.0,   // 越野王：草地保留 83% 极速
    price: 240,    // 现实 ~55 万 · 冲越野赛性价比之选

  },
  {
    id: 'yu7', name: 'Xiaomi YU7', cn: '小米 YU7', tone: '松岭绿 · 家庭纯电 SUV',
    color: 0x35754e, useGLB: true,  // models/xiaomi_yu7_opt.glb：58.6万面→24万面；CarPaint/Windows 材质
    topSpeed: 58,   // ≈209km/h：双电机 SUV，极速/加速略逊 SU7 Max
    accel: 40,
    brake: 32,
    grip: 1.00,
    offroad: 0.45,  // SUV：轻度越野能力
    price: 160,    // 现实 ~27 万

  },
  {
    id: 'su7ultra', name: 'Xiaomi SU7 Ultra', cn: '小米 SU7 Ultra', tone: '好望角黄 · 三电机纽北战神',
    color: 0xf2c811, useGLB: true,  // models/xiaomi_su7_ultra_opt.glb：68.7万面→24.8万面；黑金拉花独立材质不换漆
    topSpeed: 70,   // ≈252km/h：1548 马力三电机，全库极速/加速双第一
    accel: 45,
    brake: 37,
    grip: 1.11,
    offroad: 0,
    price: 520,    // 现实 ~80 万 · 性能天花板档（定价上探）

  },
];

// ---- 材质 ----
function paintMat(color) {
  // v2.31 与 car.js createCarFromTemplate 同规：明度提亮补偿（ACES + 背光下深色漆发黑）
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), Math.min(0.9, hsl.l * 1.18 + 0.02));
  return new THREE.MeshPhysicalMaterial({
    // 介电底漆 + 清漆：饱和度不被金属反射冲淡（高金属度会把漆色冲白/压黑）
    color: c, metalness: 0.15, roughness: 0.34,
    clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.2,
    side: THREE.DoubleSide, // 放样面片双面，免受绕序影响
  });
}
function glassMat() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x0a1220, metalness: 0.1, roughness: 0.04,
    transparent: true, opacity: 0.88, envMapIntensity: 2.4,
    side: THREE.DoubleSide,
  });
}
const trimMat = () => new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7, metalness: 0.25 });
const chromeMat = () => new THREE.MeshStandardMaterial({ color: 0xd6d9dd, metalness: 1.0, roughness: 0.22 });
function lightMat(color, intensity = 1.3) {
  return new THREE.MeshStandardMaterial({ color: 0x1c2026, emissive: color, emissiveIntensity: intensity, roughness: 0.25 });
}

// ---- 放样：keys=[z, halfW, yBot, yTop] 关键站，余弦平滑插值出 count 站 ----
function smoothKeys(keys, count) {
  const out = [];
  const seg = keys.length - 1;
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * seg;
    const k = Math.min(seg - 1, Math.floor(t));
    const u = t - k;
    const uu = (0.5 - Math.cos(u * Math.PI) / 2); // cosine ease
    const lerp = (a, b) => a + (b - a) * uu;
    out.push(keys.slice(k, k + 2).reduce((acc, key) => {
      acc.push(lerp(key[0], key[1]));
      return acc;
    }, []));
    void lerp;
  }
  // 上面 reduce 写法不便，逐参数插值：
  out.length = 0;
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * seg;
    const k = Math.min(seg - 1, Math.floor(t));
    const u = t - k;
    const uu = 0.5 - Math.cos(u * Math.PI) / 2;
    const a = keys[k], b = keys[k + 1];
    out.push([
      a[0] + (b[0] - a[0]) * uu,
      a[1] + (b[1] - a[1]) * uu,
      a[2] + (b[2] - a[2]) * uu,
      a[3] + (b[3] - a[3]) * uu,
    ]);
  }
  return out;
}

// 放样车身壳：keys=[z, halfW, yBot, yTop]，超椭圆指数 p（上）/pBot（下，默认更方→底盘平），末端自动收口
function loftHull(keys, count, material, p = 2.6, pBot = null) {
  const K = 20; // 每站环向点数
  const stations = smoothKeys(keys, count);
  const pos = [];
  const idx = [];
  for (const [z, hw, y0, y1] of stations) {
    const cy = (y0 + y1) / 2, hh = (y1 - y0) / 2;
    for (let j = 0; j < K; j++) {
      const a = (j / K) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const pe = 2 / (s >= 0 ? p : (pBot ?? p)); // 下半用更大指数 → 底盘平整
      pos.push(
        hw * Math.sign(c) * Math.pow(Math.abs(c), pe),
        cy + hh * Math.sign(s) * Math.pow(Math.abs(s), pe),
        z
      );
    }
  }
  for (let i = 0; i < count - 1; i++) {
    for (let j = 0; j < K; j++) {
      const j2 = (j + 1) % K;
      const a = i * K + j, b = i * K + j2, c = (i + 1) * K + j, d = (i + 1) * K + j2;
      idx.push(a, c, b, b, c, d);
    }
  }
  // 两端收口：首尾中心点 + 扇形封盖
  const addCap = (ringIdx, flip) => {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < K; j++) {
      cx += pos[(ringIdx * K + j) * 3];
      cy += pos[(ringIdx * K + j) * 3 + 1];
      cz += pos[(ringIdx * K + j) * 3 + 2];
    }
    cx /= K; cy /= K; cz /= K;
    const ci = pos.length / 3;
    pos.push(cx, cy, cz);
    for (let j = 0; j < K; j++) {
      const j2 = (j + 1) % K;
      const a = ringIdx * K + j, b = ringIdx * K + j2;
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  addCap(0, true);
  addCap(count - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals(); // 平滑法线 = 曲面高光
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

// ---- 车轮：胎壁外鼓(torus，轴向朝天) + 辐条轮毂 + 刹车盘 + 卡钳 ----
function makeWheel(radius, rimColor, spokes = 5) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(
    new THREE.TorusGeometry(radius - 0.09, 0.09, 12, 22),
    new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.92 })
  );
  tire.rotation.y = Math.PI / 2; // 圈面转向侧视 → 轮轴向 X（左右）
  tire.castShadow = true;
  g.add(tire);
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, 0.24, 18),
    new THREE.MeshStandardMaterial({ color: rimColor, metalness: 1.0, roughness: 0.24 })
  );
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  for (let k = 0; k < spokes; k++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.24, radius * 1.1, 0.06), rim.material);
    sp.rotation.x = (k / spokes) * Math.PI;
    g.add(sp);
  }
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, 0.06, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.8, roughness: 0.4 })
  );
  disc.rotation.z = Math.PI / 2;
  g.add(disc);
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08), new THREE.MeshStandardMaterial({
    color: 0xc23b2a, roughness: 0.5, metalness: 0.3,
  }));
  caliper.position.y = 0.16;
  g.add(caliper);
  return g;
}

function placeWheels(g, wheel, halfW, frontZ, rearZ) {
  const wheels = [];
  for (const [sx, sz] of [[-1, frontZ], [1, frontZ], [-1, rearZ], [1, rearZ]]) {
    const w = wheel.clone(true);
    w.position.set(sx * halfW, wheel.userData.r ?? 0.35, sz);
    g.add(w);
    wheels.push(w);
  }
  return wheels;
}

// 轮拱：半环黑色防刮拱，套在露出的车轮上沿
function addArches(g, wheelX, wheelZs, r) {
  const archMat = trimMat();
  for (const wz of wheelZs) {
    for (const sx of [-1, 1]) {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(r + 0.05, 0.05, 8, 14, Math.PI), archMat);
      arch.rotation.y = Math.PI / 2;
      arch.position.set(sx * (wheelX + 0.02), 0.35, wz);
      g.add(arch);
    }
  }
}

// 后视镜（细杆 + 镜壳）
function addMirrors(g, halfW, y, z) {
  const shell = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.24), paintMatShell(g));
  void shell;
}
function paintMatShell() { return trimMat(); }

// ---- 各车型构建 ----

// Tesla Model S：低趴溜背轿跑，玻璃穹顶，贯穿灯带
function buildTesla(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  // 车身壳（腰线以下）
  g.add(loftHull([
    [-2.32, 0.78, 0.36, 0.78],
    [-2.05, 0.87, 0.31, 0.9],
    [-1.5, 0.91, 0.29, 0.95],
    [-0.7, 0.93, 0.29, 0.9],
    [0.1, 0.91, 0.29, 0.86],
    [0.9, 0.89, 0.29, 0.8],
    [1.6, 0.85, 0.3, 0.72],
    [2.05, 0.79, 0.32, 0.64],
    [2.34, 0.64, 0.36, 0.56],
  ], 26, paint, 2.6, 3.8));
  // 玻璃穹顶舱
  g.add(loftHull([
    [0.95, 0.6, 0.8, 0.95],
    [0.4, 0.71, 0.82, 1.16],
    [-0.3, 0.73, 0.82, 1.2],
    [-1.0, 0.69, 0.84, 1.08],
    [-1.6, 0.58, 0.86, 0.94],
  ], 14, glassMat(), 2.3));
  // 贯穿灯带（前白 / 后红，Tesla 标志）
  const strip = (w, c, y, z, h = 0.05) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), lightMat(c));
    s.position.set(0, y, z);
    g.add(s);
  };
  strip(1.24, 0xdff4ff, 0.6, 2.33);
  strip(1.16, 0xff2222, 0.7, -2.31, 0.06);
  // 侧裙
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 2.4), trimMat());
    skirt.position.set(sx * 0.88, 0.26, 0.1);
    g.add(skirt);
  }
  // 后视镜
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.22), trimMat());
    m.position.set(sx * 0.94, 0.86, 0.55);
    g.add(m);
  }
  addArches(g, 0.87, [1.42, -1.48], 0.37);
  const wheel = makeWheel(0.37, 0xb8bec6, 5);
  wheel.userData.r = 0.37;
  const wheels = placeWheels(g, wheel, 0.87, 1.42, -1.48);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels, paint };
}

// Porsche 911：圆润蛙灯 + 鲸鱼尾 + 双出排气
function buildPorsche(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  g.add(loftHull([
    [-2.2, 0.8, 0.36, 0.86],
    [-1.8, 0.87, 0.31, 0.96],
    [-1.2, 0.9, 0.29, 1.0],
    [-0.4, 0.92, 0.29, 0.92],
    [0.5, 0.9, 0.29, 0.8],
    [1.3, 0.86, 0.3, 0.72],
    [1.9, 0.8, 0.32, 0.64],
    [2.22, 0.7, 0.36, 0.56],
  ], 26, paint, 2.6, 3.8));
  g.add(loftHull([
    [0.6, 0.58, 0.82, 0.98],
    [0.05, 0.69, 0.84, 1.18],
    [-0.5, 0.71, 0.84, 1.16],
    [-1.25, 0.6, 0.9, 1.0],
  ], 14, glassMat(), 2.3));
  // 蛙眼圆灯（半嵌进前脸）+ 圆尾灯（贴尾面）
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), lightMat(0xfff6d8, 1.1));
    hl.position.set(sx * 0.52, 0.5, 2.22);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 12), lightMat(0xff2a1a, 1.4));
    tl.rotation.x = Math.PI / 2;
    tl.position.set(sx * 0.52, 0.66, -2.24);
    g.add(tl);
  }
  // 鲸鱼尾翼（压低贴住车尾）
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.045, 0.36), paint);
  wing.position.set(0, 1.0, -2.0);
  wing.rotation.x = -0.12;
  wing.castShadow = true;
  g.add(wing);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.18), trimMat());
    post.position.set(sx * 0.52, 0.92, -1.98);
    g.add(post);
  }
  // 双出排气 + 后扩散器
  for (const sx of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10), chromeMat());
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(sx * 0.3, 0.4, -2.18);
    g.add(pipe);
  }
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.3), trimMat());
  diffuser.position.set(0, 0.3, -2.1);
  g.add(diffuser);
  // 侧裙
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 2.3), trimMat());
    skirt.position.set(sx * 0.87, 0.26, 0.1);
    g.add(skirt);
  }
  // 后视镜
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.22), trimMat());
    m.position.set(sx * 0.93, 0.9, 0.5);
    g.add(m);
  }
  addArches(g, 0.86, [1.4, -1.44], 0.36);
  const wheel = makeWheel(0.36, 0x2a2d33, 5);
  wheel.userData.r = 0.36;
  const wheels = placeWheels(g, wheel, 0.86, 1.4, -1.44);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels, paint };
}

// Ferrari 兜底轮廓车：中置引擎楔形，侧进气 + 高尾扩散器
function buildFerrariFallback(color) {
  const g = new THREE.Group();
  const paint = paintMat(color);
  g.add(loftHull([
    [-2.2, 0.8, 0.34, 0.92],
    [-1.7, 0.88, 0.3, 1.0],
    [-0.9, 0.92, 0.29, 0.9],
    [-0.1, 0.9, 0.29, 0.86],
    [0.8, 0.87, 0.3, 0.74],
    [1.6, 0.82, 0.3, 0.64],
    [2.18, 0.7, 0.34, 0.52],
  ], 26, paint, 2.6, 3.8));
  g.add(loftHull([
    [0.75, 0.56, 0.78, 0.9],
    [0.25, 0.68, 0.8, 1.08],
    [-0.4, 0.7, 0.8, 1.06],
    [-1.15, 0.58, 0.86, 0.94],
  ], 14, glassMat(), 2.3));
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.05), lightMat(0xfff6d8));
    hl.position.set(sx * 0.55, 0.62, 2.16);
    hl.rotation.y = sx * 0.2;
    g.add(hl);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.24, 0.5), trimMat());
    intake.position.set(sx * 0.86, 0.62, -1.55);
    g.add(intake);
  }
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 0.32), trimMat());
  diffuser.position.set(0, 0.32, -2.12);
  g.add(diffuser);
  addArches(g, 0.87, [1.42, -1.44], 0.36);
  const wheel = makeWheel(0.36, 0xd6d9dd, 5);
  wheel.userData.r = 0.36;
  const wheels = placeWheels(g, wheel, 0.87, 1.42, -1.44);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels, paint };
}

// ---- 统一入口：按 spec 建车模 ----
export function buildCarModel(spec) {
  const color = spec.color ?? 0x8f1420;
  if (spec.id === 'tesla') return buildTesla(color);
  if (spec.id === 'porsche') return buildPorsche(color);
  return buildFerrariFallback(color);
}
