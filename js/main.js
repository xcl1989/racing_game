// main.js — 启动装配：渲染器/场景/灯光 → 赛道/场景/车辆 → 主循环
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'; // eslint-disable-line
import { buildTrack } from './track.js';
import { buildScenery } from './scenery.js';
import { PlayerCar, AICar, loadCarTemplate } from './car.js';
import { DustSystem, SmokeSystem, SkidMarks, RainSystem, createComposer, EngineAudio } from './fx.js';
import { initInput, input, toggleGyro, pollInput } from './input.js';
import { Game } from './game.js';
import { buildWorld } from './world.js';
import { upgradeRealism } from './realism.js';
import { setRoadWet } from './roads.js';
import { makeGlowTexture, makeCloudTexture, createSkyPainter } from './textures.js';
import { createWeather } from './weather.js';
import { createOutdoorEnvironment, SUN_DIRECTION, SUN_OFFSET } from './environment.js';
import { CAR_SPECS } from './cars.js';
import { damp, angleDelta } from './steering.js';
import { SaveManager } from './save.js'; // v2.32 存档管理（3 槽位 localStorage）

const $ = (id) => document.getElementById(id);

// ---- 加载进度条：分阶段推进（世界构建 + GLB 车模），完成后淡出 ----
const ldFill = $('ld-fill');
const ldTip = $('ld-tip');
function setProgress(pct, tip) {
  if (ldFill) ldFill.style.width = pct + '%';
  if (ldTip && tip) ldTip.textContent = tip;
}
setProgress(4, '正在启动引擎…');

// ---- 渲染器 / 场景 / 相机 ----
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
let quality = !isMobile; // 手机默认低特效

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality ? 2 : 1.25));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.07; // v2.13 与 sunny 预设同步（黄金时刻提亮）
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 天幕：equirect 渐变天穹（几何球方案曾渲染黑块，弃用；贴图背景无此坑）
// 可见天幕与反射探针共用天气色板和太阳方位。
const skyPainter = createSkyPainter();
const skyTex = skyPainter.tex;
scene.background = skyTex;
scene.fog = new THREE.Fog(0xd7e9f5, 340, 2700);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 2500);
camera.position.set(0, 5, -12);

// The visible sky stays lightweight; a linear HDR probe drives PBR lighting.
const pmrem = new THREE.PMREMGenerator(renderer);
const bakeOutdoorEnvironment = createOutdoorEnvironment(pmrem);

// ---- 灯光 ----
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x556a40, 0.62); // v2.13 与 sunny 预设同步
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2b0, 1.95);
sun.castShadow = true;
sun.shadow.mapSize.set(quality ? 4096 : 2048, quality ? 4096 : 2048); // v2.21 桌面 4K 阴影贴图
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
sun.shadow.camera.far = 380;
sun.shadow.bias = -0.00035;   // 阴影范围收紧 → 同分辨率下更锐利
sun.shadow.normalBias = 0.03; // 法线偏移：根除大面积平地上的块状阴影残斑
scene.add(sun, sun.target);

// 太阳辉光 sprite（太阳本体；天穹贴图只留环境晕，可视亮盘由 sprite 承担）
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), color: 0xfff4cc, transparent: true,
  opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
}));
sunSprite.position.copy(SUN_DIRECTION).multiplyScalar(1700);
sunSprite.scale.set(75, 75, 1);
sunSprite.material.fog = false;
scene.add(sunSprite);

// ---- 云层（远景 billboard：两层高度带，推远防头顶过曝）---
const clouds = []; // weather.js 按天气调透明度与染色（baseO 存每朵云的基准透明度）
{
  const cloudTex = makeCloudTexture();
  const N_CLOUD = isMobile ? 12 : 24;
  for (let i = 0; i < N_CLOUD; i++) {
    const high = Math.random() < 0.35; // 高层片云更淡更大
    const baseO = high ? 0.16 + Math.random() * 0.12 : 0.28 + Math.random() * 0.22;
    const c = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudTex, transparent: true,
      opacity: baseO,
      depthWrite: false,
    }));
    const a = Math.random() * Math.PI * 2;
    const r = 700 + Math.random() * 700;
    const y = high ? 380 + Math.random() * 200 : 260 + Math.random() * 220;
    c.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const s = (high ? 340 : 260) + Math.random() * 340;
    c.scale.set(s, s * 0.42, 1);
    c.material.rotation = Math.random() * Math.PI;
    c.userData.baseO = baseO;
    scene.add(c);
    clouds.push(c);
  }
}

// ---- 世界构建 ----
setProgress(18, '正在铺设环道与土路肩…');
const track = buildTrack(scene);
setProgress(30, '正在生成高速公路与城市街区…');
const world = buildWorld(scene);
setProgress(44, '正在种植森林与摆放岩石…');
const scenery = buildScenery(scene, track, world, !isMobile);
setProgress(58, '正在架设护栏与路牌…');
track.railGroup = scenery.railGroup; // 护栏组：比赛显示/漫游隐藏
track.railGroup.visible = false;
upgradeRealism(scene); // v2.15：地面/远山/雾 材质真实化（构建后遍历升级，不动生成代码）
// 玩家在世界路网（高速/乡道/城市街道）上不算越野
track.worldOnRoad = (pos) => world.onAnyRoad(pos);
// v2.20 越野分级：提供路面材质（'dirt' 土路半越野 / 'pave' 铺装）
track.surfaceOf = (pos) => world.surfaceAt(pos);

// ---- 真车模：GLB 一次加载、多车克隆（失败/超时回退程序化车）----
// 6 秒竞速超时：真浏览器内本地 GLB 秒开；headless 无头环境 Worker 不回调时自动回退
// ferrari.glb 车头朝 -Z 需翻转；tesla.glb 车头朝 +Z 且带隐藏反壳网格（排除出边界计算）
setProgress(64, '正在调运车辆…');
// v2.20b 超时改"空闲超时"：手机端 11 台车并行拉 60MB，旧版固定 6s 会把还在下载的
// 大文件（YU7 11MB）误判失败回退兜底车。现在每次 onProgress 续期 12s，仅当
// 12s 内零进展或总时长超 60s 才放弃（本地秒开不受影响，进度条照常推进）
const loadGLB = (url, opts) => new Promise((resolve) => {
  let lastTick = Date.now();
  let done = false;
  const finish = (v) => { if (!done) { done = true; clearInterval(guard); clearTimeout(total); resolve(v); } };
  const guard = setInterval(() => { // 空闲 12s 判失败
    if (Date.now() - lastTick > 12000) { console.warn('[racing] GLB 下载停滞', url); finish(null); }
  }, 1000);
  const total = setTimeout(() => { console.warn('[racing] GLB 总超时', url); finish(null); }, 60000);
  loadCarTemplate(url, (p) => {
    if (p.loaded > 0) lastTick = Date.now();
    if (p.total > 0) setProgress(64 + Math.round((p.loaded / p.total) * 22), '正在调运车辆…');
  }, opts).then((v) => finish(v)).catch((e) => {
    console.warn('[racing] GLB 加载失败', url, e);
    finish(null);
  });
});
const [ferrariTemplate, teslaTemplate, porscheTemplate, su7Template, g63Template, conceptTemplate, m4Template, m2g87Template, jeepTemplate, yu7Template, su7ultraTemplate] = await Promise.all([
  loadGLB('models/ferrari.glb'),
  loadGLB('models/tesla.glb', { flip: false, skipBounds: ['Object_45', 'Object_47'] }),
  loadGLB('models/porsche.glb', { flip: false }),
  // v2.16 三台新车：Sketchfab 系（SU7/G63）实测 +Z 车头，与 tesla/porsche 同规 flip:false；
  // concept 为 Khronos Blender 导出，同按 +Z 起步，截图目检后再定
  loadGLB('models/sus7_max.glb', { flip: false }),
  loadGLB('models/g63.glb', { flip: false }),
  loadGLB('models/concept.glb', { flip: false }),
  // v2.16.1 二批：bmw_m4 为拆轮加工版；tesla_m3 暂缓（轮结构混乱，浮空备用轮 junk，
  // 待离线手术后再接入，模型保留 models/tesla_m3_*.glb）
  loadGLB('models/bmw_m4_opt.glb', { flip: false }),
  // v2.19 新车：sedan_main.glb = BMW M2 Coupe (G87)（Sketchfab recycled 系，3DWheel 分件
  // + Wheel1A 辐条，与 SU7/G63 同构；实测 +Z 车头；材质 Paint/Window 命名可被换漆命中）
  loadGLB('models/sedan_main.glb', { flip: false }),
  // v2.20 三台新车（raw 直连下载自 jiaxiantao/3d-car-viewing → tools_simplify 简化；
  // 三台均 +Z 车头截图实测 flip:false；Jeep 轮名 Ani_Wheel_*、YU7/Ultra 轮结构与 SU7 Max 同源）
  loadGLB('models/jeep_wrangler_392_opt.glb', { flip: false }),
  loadGLB('models/xiaomi_yu7_web.glb', { flip: false }),
  loadGLB('models/xiaomi_su7_ultra_web.glb', { flip: false }),
]);
const CAR_TEMPLATES = {
  ferrari: ferrariTemplate, tesla: teslaTemplate, porsche: porscheTemplate,
  su7: su7Template, g63: g63Template, concept: conceptTemplate,
  m4: m4Template, m2g87: m2g87Template,
  jeep392: jeepTemplate, yu7: yu7Template, su7ultra: su7ultraTemplate,
};
console.log('[racing] car models =', Object.fromEntries(
  Object.entries(CAR_TEMPLATES).map(([k, v]) => [k, v ? 'glb' : 'fallback']),
));
setProgress(88, '正在热车…');

const player = new PlayerCar(CAR_SPECS[0], ferrariTemplate); // 默认深红 Ferrari，选车后可换
scene.add(player.group);
const ais = [
  new AICar(0xd9dade, -3.5, 32, ferrariTemplate),   // 银（v2.20 车速随极速谱系上调 ×~1.33）
  new AICar(0x24405e, 0.5, 35, ferrariTemplate),    // 深蓝
  new AICar(0x3f444c, 3.5, 38, ferrariTemplate),    // 石墨灰
];
ais.forEach((a) => { a.group.visible = false; scene.add(a.group); });

// ---- NPC 车流（v2.19 重做）：分散全图 + 加量 ----
// 每条路线多台车按"均匀分槽+随机抖动"相位分布（startT），不再全堆在路线起点；
// 桌面 ~29 台 / 手机 ~15 台（isMobile 减半保帧率）
const traffic = [];
{
  const rnd = (a, b) => a + Math.random() * (b - a);
  const palette = [
    0x3a4048, 0x8a929c, 0x5b6b7c, 0x746666, 0xd8b022, 0x4a6b52, 0x7a6a55,
    0x6a7d5a, 0x4d5665, 0x8a7f6a, 0x557f6f, 0x6b5d7a, 0x5d6b7a, 0x8a6a52,
    0x46586e, 0x9a8a6a,
  ];
  // T(路线, 台数, [最低,最高]车速, 车道或(dir→车道), 是否双向)
  const q = isMobile ? 0.45 : 1;
  const T = (route, count, sp, laneOf, twoWay = false) => {
    const n = Math.max(1, Math.round(count * q));
    for (let k = 0; k < n; k++) {
      const dir = twoWay ? (k % 2 === 0 ? 1 : -1) : 1;
      traffic.push(new AICar(
        palette[traffic.length % palette.length],
        typeof laneOf === 'function' ? laneOf(dir) : laneOf,
        rnd(sp[0], sp[1]),
        ferrariTemplate,
        route,
        dir,
        (k + Math.random() * 0.6) / n, // 相位：均匀分槽 + 60% 槽宽抖动
      ));
    }
  };
  T(world.highway, 7, [26, 33], -2.6, true); // 高速双向
  T(world.cityRoute, 5, [11, 15], () => (traffic.length % 2 === 0 ? -3 : 3)); // 城市环线（会等红灯）
  T(world.country, 3, [12, 16], () => 2);                          // 乡道土路
  T(world.national, 4, [18, 22], (d) => (d === 1 ? 4 : -4), true); // 国道双向
  T(world.lakeRoad, 2, [12, 15], () => 2);                         // 湖滨路
  T(world.mountainRoad, 2, [9, 12], () => 2.2);                    // 盘山慢车
  T(world.westLake, 2, [13, 16], () => 2);                         // 湖西环路
  T(world.northInterchange.traffic, 1, [26, 29], 0);                        // 北大道通勤
  T(world.eastConn, 1, [24, 27], () => 3);                         // 东连接大道
  T(world.southConn, 1, [22, 26], () => 3);                        // 南连接大道
  T(world.swLink, 1, [20, 24], () => 3);                           // 西南连接线
}
traffic.forEach((t) => { t.group.visible = false; scene.add(t.group); });

const dust = new DustSystem(scene);
const skids = new SkidMarks(scene);
const smoke = new SmokeSystem(scene, quality ? 46 : 24);
const audio = new EngineAudio();
// 户外泛光保留给高亮信标；高画质额外启用 GTAO。
const composer = createComposer(renderer, scene, camera, true, quality, quality ? 0.18 : 0.10);

// ---- 游戏与输入 ----
const game = new Game({ track, player, ais, dust, skids, smoke, audio, world, traffic });
// v2.32 存档管理：3 槽位 + 最近槽位指针；未挂档（slotId<0）时 save() 静默跳过
const saveMgr = new SaveManager();
game.saveMgr = saveMgr;
game.toMenu();

// ---- 天气系统：晴/多云/阴/雨动态切换（雨粒子 + 雨声 + 湿滑联动）----
const rain = new RainSystem(scene, isMobile ? 380 : 900);
const weather = createWeather({
  scene, painter: skyPainter, bakeEnvironment: bakeOutdoorEnvironment,
  hemi, sun, sunSprite, clouds, fog: scene.fog,
  rain, audio,
  onNotice: (n) => game.toast(`天气转${n}了`, 2600),
});
// 加载完成：进度拉满 + 淡出遮罩（menu 已由 toMenu() 显示）
setProgress(100, '准备发车！');
{
  const ld = $('loading');
  setTimeout(() => {
    ld.classList.add('done');
    setTimeout(() => ld.remove(), 700);
  }, 350);
}
initInput(() => game.togglePause());

// ---- 车型选择（v2.14 Forza 式单车展厅）----
// 选车面板打开期间 showroom=true：相机切环绕展示（慢速自转 + 画布拖拽旋转），
// 切换车型用缓存模板即时重建玩家车模；确认后照常 startMode('free')。
// 兼容层：#carCards 里保留隐藏 .car-card（autotest 钩子与全部测试脚本点击它进游戏）。
let carIdx = 0;
let showroom = false;
// ---- v2.14 车库展厅：独立 Scene（不渲染主世界），霓虹灯带 + 反光地板 + 中央展台 ----
// 渲染时把 composer 的 RenderPass.scene 热切到本场景（bloom 辉光作用于灯带），
// 环境反射与主场景共享（weather 重烘 PMREM 后每帧同步引用，车漆反射天空不棚拍）
// ---- v2.14.2 写实车库展厅：混凝土空间 + 钢梁屋顶 + 工作灯 + 卷帘门 + 自然窗光 ----
// 独立 Scene（不渲染主世界），RenderPass 热切渲染；环境反射用 RoomEnvironment（中性室内，车漆不反天空）
const showroomScene = new THREE.Scene(); // v2.16.1 补声明：原代码直接使用未声明（ReferenceError 页面起不来）
{
  // --- 程序纹理：混凝土地面 / 卷帘门 / 横幅 ---
  function concreteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d');
    x.fillStyle = '#8e8c86';
    x.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 2600; k++) { // 混凝土颗粒噪声
      const g = 120 + Math.random() * 40;
      x.fillStyle = `rgba(${g},${g - 4},${g - 10},${0.12 + Math.random() * 0.1})`;
      x.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
    for (let k = 0; k < 14; k++) { // 深浅污渍斑
      x.fillStyle = `rgba(40,40,38,${0.04 + Math.random() * 0.08})`;
      x.beginPath();
      x.ellipse(Math.random() * 512, Math.random() * 512, 20 + Math.random() * 70, 14 + Math.random() * 50, Math.random() * 3, 0, 7);
      x.fill();
    }
    x.strokeStyle = 'rgba(50,50,48,0.85)'; // 板缝（对应世界 4m 一格）
    x.lineWidth = 3;
    x.strokeRect(1, 1, 510, 510);
    x.beginPath(); x.moveTo(256, 0); x.lineTo(256, 512); x.moveTo(0, 256); x.lineTo(512, 256); x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  function doorTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 384;
    const x = c.getContext('2d');
    for (let k = 0; k < 12; k++) { // 卷帘横板（明暗条 + 高光边）
      const y = k * 32;
      x.fillStyle = k % 2 ? '#71757a' : '#7d8186';
      x.fillRect(0, y, 512, 32);
      x.fillStyle = 'rgba(255,255,255,0.14)';
      x.fillRect(0, y, 512, 3);
      x.fillStyle = 'rgba(0,0,0,0.28)';
      x.fillRect(0, y + 29, 512, 3);
    }
    x.fillStyle = 'rgba(0,0,0,0.15)';
    for (let k = 0; k < 40; k++) x.fillRect(Math.random() * 512, Math.random() * 384, 2, 10 + Math.random() * 30);
    return new THREE.CanvasTexture(c);
  }
  function bannerTexture() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 224;
    const x = c.getContext('2d');
    x.fillStyle = '#151c2c';
    x.fillRect(0, 0, 1024, 224);
    x.fillStyle = '#2ee6ff';
    x.fillRect(0, 0, 1024, 10);
    x.fillRect(0, 214, 1024, 10);
    x.fillStyle = '#e8f4ff';
    x.font = '900 88px sans-serif';
    x.textAlign = 'center';
    x.fillText('NEON RUSH GARAGE', 512, 142);
    return new THREE.CanvasTexture(c);
  }

  // --- 空间：32×24m 混凝土房间，墙高 7m ---
  const ROOM = { x: 16, z: 12, h: 7 };
  const concrete = concreteTexture();
  const wallTex = concreteTexture();
  wallTex.repeat.set(4, 1.4);
  concrete.repeat.set(8, 6);
  // 四墙+顶底用内翻盒一次成型，地板/天花板单独贴混凝土面覆盖
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.x * 2 + 1, ROOM.h, ROOM.z * 2 + 1),
    new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, metalness: 0, side: THREE.BackSide })
  );
  shell.position.y = ROOM.h / 2;
  showroomScene.add(shell);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.x * 2, ROOM.z * 2),
    new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  showroomScene.add(floor);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.x * 2, ROOM.z * 2),
    new THREE.MeshStandardMaterial({ color: 0x3c3e40, roughness: 0.95 })
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = ROOM.h - 0.02;
  showroomScene.add(ceil);

  // --- 屋顶钢梁 + 长条工作灯（暖白）---
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.6, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xd9dce0, emissive: 0xffe9c8, emissiveIntensity: 1.15 });
  for (const z of [-6, -2, 2, 6]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ROOM.x * 2 + 0.8, 0.4, 0.55), beamMat);
    beam.position.set(0, ROOM.h - 0.3, z);
    showroomScene.add(beam);
    for (const lx of [-6, 6]) { // 每根梁下挂两段灯条
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.14, 0.4), lampMat);
      lamp.position.set(lx, ROOM.h - 0.75, z);
      showroomScene.add(lamp);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), beamMat);
      rod.position.set(lx, ROOM.h - 0.35, z);
      showroomScene.add(rod);
    }
  }

  // --- 正面卷帘门（含门框）---
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 5.6),
    new THREE.MeshStandardMaterial({ map: doorTexture(), roughness: 0.55, metalness: 0.55 })
  );
  door.position.set(0, 2.8, ROOM.z - 0.05);
  showroomScene.add(door);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.6, metalness: 0.5 });
  for (const fx of [-5.7, 5.7]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.8, 0.35), frameMat);
    jamb.position.set(fx, 2.9, ROOM.z - 0.15);
    showroomScene.add(jamb);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 0.35), frameMat);
  lintel.position.set(0, 5.65, ROOM.z - 0.15);
  showroomScene.add(lintel);

  // --- 后墙三扇天光窗（自然光感；框用四条细边避免厚框挡住发光窗面）---
  const wfMat = frameMat;
  for (const wx of [-7, 0, 7]) {
    const win = new THREE.Mesh(
      new THREE.PlaneGeometry(5.5, 2.6),
      new THREE.MeshStandardMaterial({ color: 0xdfe9f5, emissive: 0xcfe0f2, emissiveIntensity: 0.85 })
    );
    win.position.set(wx, 4.6, -(ROOM.z - 0.06));
    win.rotation.y = Math.PI;
    showroomScene.add(win);
    const dims = [[5.9, 0.18, 3.15, 4.6], [5.9, 0.18, 6.05, 4.6], [0.18, 3.0, wx - 2.95, 4.6], [0.18, 3.0, wx + 2.95, 4.6]];
    for (const [bw, bh, px, py] of dims) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.2), wfMat);
      bar.position.set(px, py, -(ROOM.z - 0.15));
      showroomScene.add(bar);
    }
  }

  // --- 横幅（左墙）---
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 2.4),
    new THREE.MeshStandardMaterial({ map: bannerTexture(), roughness: 0.8, emissive: 0x223344, emissiveIntensity: 0.25 })
  );
  banner.position.set(-(ROOM.x - 0.05), 4.4, 0);
  banner.rotation.y = Math.PI / 2;
  showroomScene.add(banner);

  // --- 道具：轮胎堆 / 油桶 / 工具柜 / 立式备胎 ---
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.92 });
  const tireGeo = new THREE.TorusGeometry(0.52, 0.24, 10, 20);
  tireGeo.rotateX(Math.PI / 2);
  const tirePos = [[10.2, -8.6, 0], [10.2, -8.6, 1], [11.4, -8.4, 0], [11.4, -8.4, 1], [10.8, -8.5, 2]];
  for (const [tx, tz, lvl] of tirePos) {
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.position.set(tx, 0.28 + lvl * 0.52, tz);
    tire.rotation.y = Math.random() * Math.PI;
    tire.castShadow = true;
    showroomScene.add(tire);
  }
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x9e2f2a, roughness: 0.6, metalness: 0.3 });
  for (const [bx, bz, bh] of [[13.5, -6.5, 0], [13.5, -6.5, 1], [12.2, -6.2, 0]]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.15, 16), barrelMat);
    barrel.position.set(bx, 0.58 + bh * 1.15, bz);
    barrel.castShadow = true;
    showroomScene.add(barrel);
  }
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(5, 2.1, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x8a3328, roughness: 0.55, metalness: 0.35 })
  );
  cab.position.set(6, 1.05, -(ROOM.z - 0.75));
  cab.castShadow = true;
  showroomScene.add(cab);
  for (let k = 0; k < 4; k++) { // 工具柜抽屉拉手线
    const pull = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.06, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.4, metalness: 0.7 }));
    pull.position.set(6, 0.5 + k * 0.42, -(ROOM.z - 0.18));
    showroomScene.add(pull);
  }

  // --- 中央展台：混凝土转盘 + 白色画线车位圈 ---
  const dais = new THREE.Mesh(
    new THREE.CylinderGeometry(2.9, 3.05, 0.16, 48),
    new THREE.MeshStandardMaterial({ color: 0x9b9993, roughness: 0.85 })
  );
  dais.position.y = 0.08;
  dais.receiveShadow = true;
  showroomScene.add(dais);
  const line = new THREE.Mesh(
    new THREE.RingGeometry(2.55, 2.75, 48),
    new THREE.MeshStandardMaterial({ color: 0xd8d5cc, roughness: 0.8, side: THREE.DoubleSide })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.17;
  showroomScene.add(line);

  // --- 灯光：4 盏暖白工作灯（均匀）+ 主聚光（阴影）+ 窗光斜射 ---
  const workLamps = [];
  for (const z of [-6, -2, 2, 6]) {
    const pl = new THREE.PointLight(0xffead5, 17, 0, 2);
    pl.position.set(0, ROOM.h - 0.9, z);
    showroomScene.add(pl);
    workLamps.push(pl);
  }
  const key = new THREE.SpotLight(0xfff5e9, 118, 0, 0.68, 0.65, 2);
  key.position.set(3, ROOM.h - 0.4, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  showroomScene.add(key, key.target);
  const winLight = new THREE.DirectionalLight(0xdfe8f2, 0.62);
  winLight.position.set(-4, 6, -14);
  winLight.target.position.set(2, 0, 6);
  showroomScene.add(winLight, winLight.target);
  showroomScene.add(new THREE.HemisphereLight(0x4a4d52, 0x35342f, 0.42));
}

// 展厅环境反射：RoomEnvironment 中性室内（车漆反射真实、不反户外天空）
// RoomEnvironment 已在文件头 import（line 3）—— 重复 import 会导致整模块解析失败
const studioProbe = new RoomEnvironment();
const showroomEnv = pmrem.fromScene(studioProbe, 0.04);
studioProbe.traverse((object) => {
  object.geometry?.dispose();
  object.material?.dispose();
});
showroomScene.environment = showroomEnv.texture;

function syncRenderProfile() {
  composer.renderPass.scene = showroom ? showroomScene : scene;
  if (composer.gtao) composer.gtao.enabled = quality && !showroom;
  composer.bloom.enabled = !showroom;
  composer.bloom.strength = quality ? 0.18 : 0.10;
  renderer.toneMappingExposure = showroom ? 0.82 : weather.exposure;
}

function renderCarInfo(spec) {
  // v2.20 属性条动态归一：分母不再硬编码（旧 norm 随参数上调溢出失真），
  // 改为按全库 min~max 拉开映射到 12%~100% —— 以后调参永远自适应
  const stats = [['极速', 'topSpeed'], ['加速', 'accel'], ['刹车', 'brake'], ['操控', 'grip']];
  const bar = (label, key) => {
    const vs = CAR_SPECS.map((s) => s[key]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const w = Math.round(12 + 88 * ((spec[key] - lo) / (hi - lo)));
    return `
    <div class="stat"><span class="k">${label}</span>
      <span class="track"><span class="fill" style="width:${w}%"></span></span>
    </div>`;
  };
  const kmh = Math.round(spec.topSpeed * 3.6);
  $('carName').innerHTML = `${spec.name}<i id="carChip" style="background:#${spec.color.toString(16).padStart(6, '0')}"></i>`;
  $('carTone').textContent = `${spec.tone} · 极速 ${kmh} km/h`;
  // v2.32 车店价格行：new 模式隐藏；shop 模式按 所拥有/买得起/买不起 三态
  const priceEl = $('carPrice');
  if (selectPurpose === 'shop') {
    priceEl.style.display = 'block';
    if (game.owns(spec.id)) { priceEl.textContent = '✓ 已入库'; priceEl.className = 'owned'; }
    else if (game.credits >= spec.price) { priceEl.textContent = `🛒 ${spec.price} 💎`; priceEl.className = ''; }
    else { priceEl.textContent = `🔒 ${spec.price} 💎（还差 ${spec.price - game.credits}）`; priceEl.className = 'locked'; }
  } else priceEl.style.display = 'none';
  $('carStats').innerHTML = stats.map(([l, k]) => bar(l, k)).join('');
  const dots = $('carDots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === carIdx);
  // 确认按钮三态（同价格行语义）
  const go = $('btn-carGo');
  if (selectPurpose === 'new' || game.owns(spec.id)) { go.textContent = selectPurpose === 'new' ? '✓ 开上它' : '✓ 换这辆'; go.disabled = false; }
  else if (game.credits >= spec.price) { go.textContent = `🛒 购买 ${spec.price} 💎`; go.disabled = false; }
  else { go.textContent = `🔒 ${spec.price} 💎`; go.disabled = true; }
}

function showCar(idx) {
  carIdx = (idx + CAR_SPECS.length) % CAR_SPECS.length;
  const spec = CAR_SPECS[carIdx];
  player.applySpec(spec, spec.useGLB ? (CAR_TEMPLATES[spec.id] || null) : null);
  renderCarInfo(spec);
}

// ---- v2.32 展厅用途：'new'=新存档选首车（免费入库） / 'shop'=车店（购买+换车）----
let selectPurpose = 'new';
let garageReturn = null; // 'pause'=从暂停菜单进店，关店回暂停；null=主菜单进店，关店回菜单

function closeSelectUI() {
  $('carSelect').style.display = 'none';
  showroomExit();
}

// 进自由漫游（新档/读档/换车后），有存档位置则传回原地
function enterFree(spec, msg) {
  game.startMode('free');
  const pos = game._savedPos;
  if (pos) player.reset(new THREE.Vector3(pos.x, 0, pos.z), pos.yaw);
  $('mode-val').textContent = `自由漫游 · ${spec.name}`;
  game.toast(msg, 3200);
  updateMenuButtons();
}

function confirmCar() {
  const spec = CAR_SPECS[carIdx];
  if (selectPurpose === 'new') {
    // 新存档：首车免费入库 → 建槽 → 出发
    const slotId = saveMgr.createSlot(spec.id);
    if (slotId < 0) { game.toast('存档已满（3 个），请先在「存档管理」删除旧档', 3200); return; }
    game.attachSave(slotId, saveMgr.read(slotId), saveMgr);
    closeSelectUI();
    enterFree(spec, `🗂 新存档已创建 · ${spec.name} 免费入库`);
    return;
  }
  // 车店：未拥有先购（余额不足由按钮置灰兜底，这里双保险），再换驾
  if (!game.owns(spec.id) && !game.buy(spec)) return;
  game.carId = spec.id;
  game.save();
  closeSelectUI();
  if (garageReturn === 'pause') {
    garageReturn = null;
    $('pauseMenu').style.display = 'flex';
    game.toast(`已换驾 ${spec.name} · 💎 余额 ${game.credits}`, 2400);
  } else {
    enterFree(spec, `已驾驶 ${spec.name} — 开到彩色光柱可参加比赛`);
  }
}

// 退出展厅：车模移回主场景 + RenderPass 切回（位置由 startMode/toMenu 的 reset 处理）
function showroomExit() {
  showroom = false;
  scene.add(player.group);
  syncRenderProfile();
}

function buildCarCards() { // 兼容层：隐藏卡片，onclick 走确认逻辑（测试点击入口）
  const box = $('carCards');
  box.innerHTML = '';
  CAR_SPECS.forEach((spec, i) => {
    const card = document.createElement('button');
    card.className = 'car-card';
    card.textContent = spec.name;
    card.onclick = () => { carIdx = i; confirmCar(); };
    box.appendChild(card);
  });
  const dots = $('carDots');
  dots.innerHTML = '';
  CAR_SPECS.forEach(() => dots.appendChild(document.createElement('i')));
}

function openCarSelect(purpose = 'new') {
  selectPurpose = purpose;
  buildCarCards();
  $('menu').style.display = 'none';
  $('saveSlots').style.display = 'none';
  $('pauseMenu').style.display = 'none'; // 从暂停进车店时收起暂停面板
  $('carSelect').style.display = 'flex';
  showroom = true;
  look.yaw = 0; look.pitch = 0; // 展厅视角回正
  // 车模挂进展厅场景、落座展台；RenderPass 热切渲染目标（真实车库 bloom 调弱）
  showroomScene.add(player.group);
  player.reset({ x: 0, y: 0.17, z: 0 }, Math.PI / 2);
  syncRenderProfile();
  showCar(carIdx);
}
$('btn-start').onclick = () => openCarSelect('new');
$('btn-carBack').onclick = () => {
  closeSelectUI();
  if (garageReturn === 'pause') { garageReturn = null; $('pauseMenu').style.display = 'flex'; }
  else game.toMenu();
};
$('btn-carPrev').onclick = () => showCar(carIdx - 1);
$('btn-carNext').onclick = () => showCar(carIdx + 1);
// v2.16 调试钩子：自动化验收切车 / 展厅环绕视角（只读上层状态，不改玩法）
window.carDebug = {
  specs: CAR_SPECS,
  templates: CAR_TEMPLATES,
  open: () => openCarSelect(),
  show: (i) => showCar(i),
  close: closeSelectUI,
  orbit: (yaw) => { look.yaw = yaw; look.pitch = 0; }, // 展厅环绕角：0=车尾, π=车头
  wheels: () => player.wheels,
  idx: () => carIdx,
};
$('btn-carGo').onclick = confirmCar;
// 键盘左右切换（展厅内）
window.addEventListener('keydown', (e) => {
  if (!showroom) return;
  if (e.key === 'ArrowLeft') showCar(carIdx - 1);
  else if (e.key === 'ArrowRight') showCar(carIdx + 1);
  else if (e.key === 'Enter') confirmCar();
});

// 菜单上的特效/声音开关（v2.22 语义：档位切换 像素比 + GTAO + Bloom 强度，Bloom 两端常开）
$('btn-quality').onclick = () => {
  quality = !quality;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality ? 2 : 1.25));
  composer.setPixelRatio(renderer.getPixelRatio());
  syncRenderProfile();
  $('btn-quality').textContent = `特效: ${quality ? '高' : '低'}`;
};
$('btn-sound').onclick = () => {
  audio.init();
  const on = audio.toggle();
  $('btn-sound').textContent = `声音: ${on ? '开' : '关'}`;
};
$('btn-gyro').onclick = () => {
  toggleGyro().then((r) => {
    $('btn-gyro').textContent = `陀螺仪: ${r.on ? '开' : '关'}`;
    if (!r.ok) game.toast(r.msg, 3500);
    else if (r.on) game.toast('倾斜手机回正，开启瞬间的握持姿态 = 回正位', 3000);
    else game.toast('陀螺仪已关闭，改用虚拟按键', 2000);
  });
};

// ---- v2.32 存档管理面板 / 继续游戏 / 车店入口 / 关页兜底存档 ----
function updateMenuButtons() {
  const last = saveMgr.lastSlot >= 0 ? saveMgr.read(saveMgr.lastSlot) : null;
  $('btn-continue').style.display = last ? 'block' : 'none';
  $('btn-garage').style.display = last ? 'block' : 'none';
  if (last) {
    const spec = CAR_SPECS.find((x) => x.id === last.car) || CAR_SPECS[0];
    $('cont-sub').textContent =
      `${last.name} · ${spec.cn} · 💎${last.credits} · ${(last.odoTotal / 1000).toFixed(1)}km`;
  }
}

function startSlot(slotId) {
  const data = saveMgr.read(slotId);
  if (!data) return;
  saveMgr.lastSlot = slotId;
  try { localStorage.setItem('rg_save_last', String(slotId)); } catch { /* noop */ }
  const spec = CAR_SPECS.find((x) => x.id === data.car) || CAR_SPECS[0];
  player.applySpec(spec, spec.useGLB ? (CAR_TEMPLATES[spec.id] || null) : null);
  game.attachSave(slotId, data, saveMgr);
  enterFree(spec, `📂 已读取「${data.name}」 · 继续你的旅程`);
}

function renderSlots() {
  const box = $('slotList');
  box.innerHTML = '';
  saveMgr.listMeta().forEach((s) => {
    const card = document.createElement('div');
    if (!s.exists) {
      card.className = 'slot-card empty';
      card.innerHTML = `<h4>存档 ${s.id + 1}</h4><div style="font-size:30px">＋</div><div class="meta">新存档 · 选一辆首车出发</div>`;
      card.onclick = () => openCarSelect('new');
    } else {
      const d = s.data;
      const spec = CAR_SPECS.find((x) => x.id === d.car) || CAR_SPECS[0];
      const wins = Object.values(d.raceLog).reduce((a, e) => a + (e.wins || 0), 0);
      card.className = 'slot-card';
      card.innerHTML = `
        <h4>存档 ${s.id + 1} · ${d.name}</h4>
        <div class="meta">🚗 ${spec.cn}</div>
        <div class="meta">💎 ${d.credits} 积分 · 🛣 ${(d.odoTotal / 1000).toFixed(1)} km</div>
        <div class="meta">🏆 冠军 ${wins} 次 · ${new Date(d.lastPlayed).toLocaleString()}</div>
        <div class="acts">
          <button data-act="load">▶ 继续</button>
          <button data-act="rename">✏️</button>
          <button data-act="del" class="danger">🗑</button>
        </div>`;
      card.querySelector('[data-act=load]').onclick = (e) => {
        e.stopPropagation();
        $('saveSlots').style.display = 'none';
        startSlot(s.id);
      };
      card.querySelector('[data-act=rename]').onclick = (e) => {
        e.stopPropagation();
        const name = prompt('存档名称：', d.name);
        if (name) { saveMgr.renameSlot(s.id, name); renderSlots(); }
      };
      card.querySelector('[data-act=del]').onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除「存档 ${s.id + 1} · ${d.name}」？不可恢复！`)) return;
        saveMgr.deleteSlot(s.id);
        if (game.slotId === s.id) { game.slotId = -1; game.bests = null; } // 卸档防误写
        updateMenuButtons();
        renderSlots();
      };
    }
    box.appendChild(card);
  });
}
$('btn-saves').onclick = () => { renderSlots(); $('menu').style.display = 'none'; $('saveSlots').style.display = 'flex'; };
$('btn-slots-back').onclick = () => { $('saveSlots').style.display = 'none'; $('menu').style.display = 'flex'; updateMenuButtons(); };
$('btn-continue').onclick = () => startSlot(saveMgr.lastSlot);
$('btn-garage').onclick = () => { garageReturn = null; openCarSelect('shop'); };
$('btn-pause-garage').onclick = () => { garageReturn = 'pause'; openCarSelect('shop'); };
// 关页/切后台兜底存档（触发点 5）
window.addEventListener('beforeunload', () => game.save());
document.addEventListener('visibilitychange', () => { if (document.hidden) game.save(); });
// 回主菜单后刷新「继续游戏」副标题（积分/里程可能已变化）
{
  const _toMenu = game.toMenu.bind(game);
  game.toMenu = () => { _toMenu(); updateMenuButtons(); };
}
updateMenuButtons(); // 初始亮「继续游戏」（有档时）

// ---- 触屏滑动转视角（不与虚拟按键冲突：只在画布空白处响应）---
const look = { yaw: 0, pitch: 0, dragging: false, id: -1, lastX: 0, lastY: 0 };
{
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', (e) => {
    if (look.dragging) return;
    look.dragging = true;
    look.id = e.pointerId;
    look.lastX = e.clientX;
    look.lastY = e.clientY;
  });
  window.addEventListener('pointermove', (e) => {
    if (!look.dragging || e.pointerId !== look.id) return;
    const dx = e.clientX - look.lastX, dy = e.clientY - look.lastY;
    look.lastX = e.clientX;
    look.lastY = e.clientY;
    look.yaw -= dx * 0.006;                                    // 横滑环绕
    look.pitch = Math.max(-0.3, Math.min(0.7, look.pitch + dy * 0.004)); // 纵滑俯仰
  });
  const endLook = (e) => { if (e.pointerId === look.id) look.dragging = false; };
  window.addEventListener('pointerup', endLook);
  window.addEventListener('pointercancel', endLook);
}

// ---- 追逐相机 ----
const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const FWD = new THREE.Vector3();
const aim = new THREE.Vector3();
let chaseYaw = null;
let showroomOrbit = 0; // 展厅慢速自转角（拖拽经 look.yaw 叠加）
function updateCamera(dt, shake) {
  // v2.14 展厅模式：车库内环绕展台车模（拖拽 look.yaw/pitch 叠加，松手不回正）
  if (showroom) {
    chaseYaw = null;
    showroomOrbit += dt * 0.25;
    const a = showroomOrbit + look.yaw;
    // 竖屏自适应：窄视野拉远相机防车模溢出裁切，同时压低目标高度让车居中偏上
    const aspect = innerWidth / Math.max(1, innerHeight);
    const portrait = aspect < 0.8;
    const r = Math.min(9.5, Math.max(6.2, (6.2 / aspect) * 0.85));
    const goal = camGoal.set(
      player.pos.x + Math.sin(a) * r,
      player.pos.y + (portrait ? 2.6 : 1.9) + look.pitch * 5.5,
      player.pos.z + Math.cos(a) * r
    );
    camera.position.lerp(goal, 1 - Math.exp(-dt * 6));
    camTarget.copy(player.pos).add({ x: 0, y: portrait ? 0.55 : 0.75, z: 0 });
    camera.lookAt(camTarget);
    camera.fov += ((portrait ? 56 : 50) - camera.fov) * (1 - Math.exp(-dt * 5));
    camera.updateProjectionMatrix();
    $('vignette').style.opacity = 0;
    return;
  }
  // 松手后视角缓慢回正
  if (!look.dragging) {
    look.yaw *= Math.exp(-dt * 2.2);
    look.pitch *= Math.exp(-dt * 2.2);
  }
  const sk = Math.min(1, Math.abs(player.speed) / 53);
  const portrait = camera.aspect < .95;
  const snap = chaseYaw === null || camera.position.distanceToSquared(player.pos) > 52 ** 2;
  chaseYaw = snap ? player.yaw : chaseYaw + damp(0, angleDelta(chaseYaw, player.yaw), dt, 8);
  const tailYaw = chaseYaw + look.yaw;
  const lead = Math.max(-.16, Math.min(.16, player.yawRate * .13)) * Math.min(1, Math.max(0, player.speed / 10));
  const aimYaw = tailYaw + lead;
  FWD.set(Math.sin(tailYaw), 0, Math.cos(tailYaw));
  aim.set(Math.sin(aimYaw), 0, Math.cos(aimYaw));
  camGoal.copy(player.pos).addScaledVector(FWD, -(8.9 + sk * 2.6 + (portrait ? 1.65 : 0)));
  camGoal.y += Math.max(1.15, 3.65 + sk * .65 + (portrait ? .35 : 0) + look.pitch * 9);
  const k = snap ? 1 : 1 - Math.exp(-dt * 8);
  camera.position.lerp(camGoal, k);
  const impact = Math.max(0, shake - .15) * .52;
  if (impact > 0) {
    camera.position.x += (Math.random() - .5) * impact * .32;
    camera.position.y += (Math.random() - .5) * impact * .21;
  }
  camTarget.copy(player.pos).addScaledVector(aim, 5.8 + sk * 9.2);
  camTarget.y += 1.48 + look.pitch * 2;
  camera.lookAt(camTarget);
  camera.fov = damp(camera.fov, 59 + sk * 10 + (portrait ? 3 : 0), dt, 5);
  camera.updateProjectionMatrix();
  // 阴影相机跟随玩家
  sun.position.copy(player.pos).add(SUN_OFFSET);
  sun.target.position.copy(player.pos);
  // 速度晕影
  $('vignette').style.opacity = (sk * sk * 0.55).toFixed(2);
}

// ---- 主循环 ----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  pollInput(); // 每帧轮询输入：AUTO 油门/陀螺仪不依赖事件即可生效
  const shake = game.update(dt, input);
  updateCamera(dt, shake);
  sunSprite.position.copy(camera.position).addScaledVector(SUN_DIRECTION, 1700);
  weather.update(dt, camera.position); // 天气：天穹/光照/雾/雨粒子/湿滑
  player.wet = weather.wet;            // 雨天抓地下降（car.js 读取）
  setRoadWet(weather.wet);             // Visual response depends on road material.
  renderer.toneMappingExposure = showroom ? 0.82 : weather.exposure;
  if (showroom) {
    // 展厅：固定 RoomEnvironment 室内反射（车漆不反户外天空），渲染车库场景
    if (composer.enabled) composer.render();
    else renderer.render(showroomScene, camera);
  } else {
    dust.update(dt);
    smoke.update(dt);
    scenery.update(dt); // 风机叶片等场景动画
    if (composer.enabled) composer.render();
    else renderer.render(scene, camera);
  }
}
animate();

// 调试/测试钩子：URL 带 #autotest 时自动走 开始自驾→选默认车→进自由漫游
if (location.hash.includes('autotest')) {
  const t = setInterval(() => {
    if (window.game) {
      clearInterval(t);
      $('btn-start').click();
      document.querySelector('#carCards .car-card').click();
    }
  }, 300);
}
window.game = game; // 供自动化测试操纵玩家位置/读取状态
window.weather = weather; // 调试钩子：force('rain') 强制变天
window.scene = scene; // 调试钩子：定位渲染异常
window.camera = camera;
window.renderer = renderer;
window.composer = composer; // v2.21 调试钩子：GTAO/Bloom 开关与调参

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

console.log('[racing] ready. quality =', quality);