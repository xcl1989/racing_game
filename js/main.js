// main.js 鈥?鍚姩瑁呴厤锛氭覆鏌撳櫒/鍦烘櫙/鐏厜 鈫?璧涢亾/鍦烘櫙/杞﹁締 鈫?涓诲惊鐜?
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'; // eslint-disable-line
import { buildTrack } from './track.js';
import { buildScenery } from './scenery.js';
import { PlayerCar, AICar, loadferrariTemplate } from './car.js';
import { DustSystem, SmokeSystem, SkidMarks, createComposer, EngineAudio } from './fx.js';
import { initInput, input, toggleGyro, pollInput } from './input.js';
import { Game } from './game.js';
import { buildWorld } from './world.js';
import { makeGlowTexture, makeCloudTexture, makeSkyTexture } from './textures.js';
import { CAR_SPECS } from './cars.js';

const $ = (id) => document.getElementById(id);

// ---- 鍔犺浇杩涘害鏉★細鍒嗛樁娈垫帹杩涳紙涓栫晫鏋勫缓 + GLB 杞︽ā锛夛紝瀹屾垚鍚庢贰鍑?----
const ldFill = $('ld-fill');
const ldTip = $('ld-tip');
function setProgress(pct, tip) {
  if (ldFill) ldFill.style.width = pct + '%';
  if (ldTip && tip) ldTip.textContent = tip;
}
setProgress(4, '姝ｅ湪鍚姩寮曟搸鈥?);

// ---- 娓叉煋鍣?/ 鍦烘櫙 / 鐩告満 ----
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
let quality = !isMobile; // 鎵嬫満榛樿浣庣壒鏁?

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality ? 2 : 1.25));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 澶╁箷锛歟quirect 娓愬彉澶╃┕锛堝嚑浣曠悆鏂规鏇炬覆鏌撳嚭榛戝潡锛屽純鐢紱璐村浘鑳屾櫙鏃犳鍧戯級
// 澶╃┕鍚屾椂鐑樼剻鐜鍙嶅皠锛屽厜鐓т笌鑳屾櫙鍚屾簮锛岄噾灞?鐜荤拑涓嶄細"妫氭媿鎰?
const skyTex = makeSkyTexture();
scene.background = skyTex;
scene.fog = new THREE.Fog(0xd7e9f5, 340, 2700);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 2500);
camera.position.set(0, 5, -12);

// 鐜鍙嶅皠锛氱洿鎺ョ敱澶╃┕ equirect 鐑樼剻锛圥MREM锛夛紝涓庢墍瑙佸ぉ绌轰竴鑷?
const pmrem = new THREE.PMREMGenerator(renderer);
function bakeEnvironment() {
  return pmrem.fromEquirectangular(skyTex).texture;
}
scene.environment = bakeEnvironment();

// ---- 鐏厜 ----
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x50663c, 0.55); // 鐜鍙嶅皠鎺ョ閮ㄥ垎琛ュ厜锛屽帇浣庡崐鐞冮槻鐏?
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe7c4, 1.85);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
sun.shadow.camera.far = 380;
sun.shadow.bias = -0.00035;   // 闃村奖鑼冨洿鏀剁揣 鈫?鍚屽垎杈ㄧ巼涓嬫洿閿愬埄
sun.shadow.normalBias = 0.03; // 娉曠嚎鍋忕Щ锛氭牴娌诲ぇ闈㈢Н骞冲湴涓婄殑鍧楃姸闃村奖鐥ょ柈
scene.add(sun, sun.target);

// 澶槼杈夊厜 sprite锛堝お闃虫湰浣擄紱澶╃┕璐村浘鍙暀鐜鏅曪紝鍙浜洏鐢?sprite 鎵挎媴锛?
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), color: 0xfff4cc, transparent: true,
  opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
}));
sunSprite.position.set(700, 900, -600);
sunSprite.scale.set(190, 190, 1);
sunSprite.material.fog = false;
scene.add(sunSprite);

// ---- 浜戝眰锛堣繙鏅?billboard锛氫袱灞傞珮搴﹀甫锛屾帹杩滈槻澶撮《杩囨洕锛?---
{
  const cloudTex = makeCloudTexture();
  const N_CLOUD = isMobile ? 12 : 24;
  for (let i = 0; i < N_CLOUD; i++) {
    const high = Math.random() < 0.35; // 楂樺眰鍗蜂簯鏇存贰鏇村ぇ
    const c = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudTex, transparent: true,
      opacity: high ? 0.16 + Math.random() * 0.12 : 0.28 + Math.random() * 0.22,
      depthWrite: false,
    }));
    const a = Math.random() * Math.PI * 2;
    const r = 700 + Math.random() * 700;
    const y = high ? 380 + Math.random() * 200 : 260 + Math.random() * 220;
    c.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const s = (high ? 340 : 260) + Math.random() * 340;
    c.scale.set(s, s * 0.42, 1);
    c.material.rotation = Math.random() * Math.PI;
    scene.add(c);
  }
}

// ---- 涓栫晫鏋勫缓 ----
setProgress(18, '姝ｅ湪閾鸿鐜亾涓庡湡璺偐鈥?);
const track = buildTrack(scene);
setProgress(30, '姝ｅ湪鐢熸垚楂橀€熷叕璺笌鍩庡競琛楀尯鈥?);
const world = buildWorld(scene);
setProgress(44, '姝ｅ湪绉嶆妫灄涓庢憜鏀惧博鐭斥€?);
const scenery = buildScenery(scene, track, world, !isMobile);
setProgress(58, '姝ｅ湪鏋惰鎶ゆ爮涓庤矾鐗屸€?);
track.railGroup = scenery.railGroup; // 鎶ゆ爮缁勶細姣旇禌鏄剧ず/婕父闅愯棌
track.railGroup.visible = false;
// 鐜╁鍦ㄤ笘鐣岃矾缃戯紙楂橀€?涔￠亾/鍩庡競琛楅亾锛変笂涓嶇畻瓒婇噹
track.worldOnRoad = (pos) => world.onAnyRoad(pos);

// ---- 鐪熻溅妯★細GLB 涓€娆″姞杞姐€佸杞﹀厠闅嗭紙澶辫触/瓒呮椂鍥為€€绋嬪簭鍖栬溅锛?---
// 6 绉掔珵閫熻秴鏃讹細鐪熸祻瑙堝櫒鍐呮湰鍦?GLB 绉掑紑锛沨eadless 鏃犲ご鐜 Worker 涓嶅洖璋冩椂鑷姩鍥為€€
// ferrari.glb 杞﹀ご鏈?-Z 闇€缈昏浆锛泃esla.glb 杞﹀ご鏈?+Z 涓斿甫闅愯棌鍙嶅３缃戞牸锛堟帓闄ゅ嚭杈圭晫璁＄畻锛?
setProgress(64, '姝ｅ湪璋冭繍 Ferrari 458 涓?Tesla Model S鈥?);
const loadGLB = (url, opts) => Promise.race([
  loadferrariTemplate(url, (p) => {
    if (p.total > 0) setProgress(64 + Math.round((p.loaded / p.total) * 22), '姝ｅ湪璋冭繍 Ferrari 458 涓?Tesla Model S鈥?);
  }, opts).catch((e) => {
    console.warn('[racing] GLB 鍔犺浇澶辫触', url, e);
    return null;
  }),
  new Promise((res) => setTimeout(() => res(null), 6000)),
]);
const [ferrariTemplate, teslaTemplate] = await Promise.all([
  loadGLB('models/ferrari.glb'),
  loadGLB('models/tesla.glb', { flip: false, skipBounds: ['Object_45', 'Object_47'] }),
]);
const CAR_TEMPLATES = { ferrari: ferrariTemplate, tesla: teslaTemplate };
console.log('[racing] car models =', {
  ferrari: ferrariTemplate ? 'glb' : 'fallback',
  tesla: teslaTemplate ? 'glb' : 'fallback',
});
setProgress(88, '姝ｅ湪鐑溅鈥?);

const player = new PlayerCar(CAR_SPECS[0], ferrariTemplate); // 榛樿娣辩孩 Ferrari锛岄€夎溅鍚庡彲鎹?
scene.add(player.group);
const ais = [
  new AICar(0xd9dade, -3.5, 24, ferrariTemplate),   // 閾?
  new AICar(0x24405e, 0.5, 26, ferrariTemplate),    // 娣辫摑
  new AICar(0x3f444c, 3.5, 28, ferrariTemplate),    // 鐭冲ⅷ鐏?
];
ais.forEach((a) => { a.group.visible = false; scene.add(a.group); });

// ---- NPC 杞︽祦锛氶珮閫熷弻鍚?+ 鍩庡競涓ゅ彴锛堜細绛夌孩鐏級+ 涔￠亾涓€鍙?----
const traffic = [
  new AICar(0x3a4048, 5, 30, ferrariTemplate, world.highway, 1),
  new AICar(0x8a929c, -5, 27, ferrariTemplate, world.highway, -1),
  new AICar(0x5b6b7c, 5, 33, ferrariTemplate, world.highway, 1),
  new AICar(0x746666, -5, 26, ferrariTemplate, world.highway, -1),
  new AICar(0xd8b022, -3, 13, ferrariTemplate, world.cityRoute, 1),  // 鍩庡競鍑虹
  new AICar(0x4a6b52, 3, 12, ferrariTemplate, world.cityRoute, 1),
  new AICar(0x7a6a55, 2, 17, ferrariTemplate, world.country, 1),
];
traffic.forEach((t) => { t.group.visible = false; scene.add(t.group); });

const dust = new DustSystem(scene);
const skids = new SkidMarks(scene);
const smoke = new SmokeSystem(scene, quality ? 46 : 24);
const audio = new EngineAudio();
let composer = createComposer(renderer, scene, camera, quality);

// ---- 娓告垙涓庤緭鍏?----
const game = new Game({ track, player, ais, dust, skids, smoke, audio, world, traffic });
game.toMenu();
// 鍔犺浇瀹屾垚锛氳繘搴︽媺婊?+ 娣″嚭閬僵锛坢enu 宸茬敱 toMenu() 鏄剧ず锛?
setProgress(100, '鍑嗗鍙戣溅锛?);
{
  const ld = $('loading');
  setTimeout(() => {
    ld.classList.add('done');
    setTimeout(() => ld.remove(), 700);
  }, 350);
}
initInput(() => game.togglePause());

// ---- 杞﹀瀷閫夋嫨锛氬紑濮嬭嚜椹?鈫?閫夎溅鍗＄墖 鈫?applySpec + 杩涜嚜鐢辨极娓?----
function buildCarCards() {
  const box = $('carCards');
  box.innerHTML = '';
  const norm = { speed: 50, accel: 30, brake: 32, grip: 1.1 };
  for (const spec of CAR_SPECS) {
    const card = document.createElement('button');
    card.className = 'car-card';
    const bar = (k, v, max) => `
      <div class="stat"><span class="k">${k}</span>
        <span class="track"><span class="fill" style="width:${Math.round((v / max) * 100)}%"></span></span>
      </div>`;
    const kmh = Math.round(spec.topSpeed * 3.6);
    card.innerHTML = `
      <h3>${spec.name}<span class="chip" style="background:#${spec.color.toString(16).padStart(6, '0')}"></span></h3>
      <div class="tone">${spec.tone} 路 鏋侀€?${kmh} km/h</div>
      ${bar('鏋侀€?, spec.topSpeed, norm.speed)}
      ${bar('鍔犻€?, spec.accel, norm.accel)}
      ${bar('鍒硅溅', spec.brake, norm.brake)}
      ${bar('鎿嶆帶', spec.grip, norm.grip)}
    `;
    card.onclick = () => {
      $('carSelect').style.display = 'none';
      player.applySpec(spec, spec.useGLB ? ferrariTemplate : null);
      game.startMode('free');
      $('mode-val').textContent = `鑷敱婕父 路 ${spec.name}`;
      game.toast(`宸查┚椹?${spec.name} 鈥?寮€鍒板僵鑹插厜鏌卞彲鍙傚姞姣旇禌`, 3200);
    };
    box.appendChild(card);
  }
}
$('btn-start').onclick = () => {
  buildCarCards();
  $('menu').style.display = 'none';
  $('carSelect').style.display = 'flex';
};
$('btn-carBack').onclick = () => {
  $('carSelect').style.display = 'none';
  game.toMenu();
};

// 鑿滃崟涓婄殑鐗规晥/澹伴煶寮€鍏?
$('btn-quality').onclick = () => {
  quality = !quality;
  composer.enabled = quality;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality ? 2 : 1.25));
  $('btn-quality').textContent = `鐗规晥: ${quality ? '楂? : '浣?}`;
};
$('btn-sound').onclick = () => {
  audio.init();
  const on = audio.toggle();
  $('btn-sound').textContent = `澹伴煶: ${on ? '寮€' : '鍏?}`;
};
$('btn-gyro').onclick = () => {
  toggleGyro().then((r) => {
    $('btn-gyro').textContent = `闄€铻轰华: ${r.on ? '寮€' : '鍏?}`;
    if (!r.ok) game.toast(r.msg, 3500);
    else if (r.on) game.toast('鍊炬枩鎵嬫満杞悜锛屽紑鍚椂鐨勬彙鎸佸Э鎬?= 鍥炴浣?, 3000);
    else game.toast('闄€铻轰华宸插叧闂紝鏀圭敤铏氭嫙鎸夐敭', 2000);
  });
};

// ---- 瑙﹀睆婊戝姩杞瑙掞紙涓嶄笌铏氭嫙鎸夐敭鍐茬獊锛氬彧鍦ㄧ敾甯冪┖鐧藉鍝嶅簲锛?---
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
    look.yaw -= dx * 0.006;                                    // 妯粦鐜粫
    look.pitch = Math.max(-0.3, Math.min(0.7, look.pitch + dy * 0.004)); // 绾垫粦淇话
  });
  const endLook = (e) => { if (e.pointerId === look.id) look.dragging = false; };
  window.addEventListener('pointerup', endLook);
  window.addEventListener('pointercancel', endLook);
}

// ---- 杩介€愮浉鏈?----
const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const FWD = new THREE.Vector3();
function updateCamera(dt, shake) {
  // 鏉炬墜鍚庤瑙掔紦鎱㈠洖姝?
  if (!look.dragging) {
    look.yaw *= Math.exp(-dt * 2.2);
    look.pitch *= Math.exp(-dt * 2.2);
  }
  FWD.set(Math.sin(player.yaw + look.yaw), 0, Math.cos(player.yaw + look.yaw));
  const sk = Math.min(1, Math.abs(player.speed) / 47);
  // 楂橀€熸椂鐩告満鎷夎繙鎷夐珮锛屽寮洪€熷害鎰燂紱绾垫粦鎶珮/鍘嬩綆瑙嗚
  camGoal.copy(player.pos).addScaledVector(FWD, -(9.5 + sk * 2.5))
    .add({ x: 0, y: Math.max(1.2, 4.2 + sk * 0.6 + look.pitch * 9), z: 0 });
  const k = 1 - Math.exp(-dt * 5);
  camera.position.lerp(camGoal, k);
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.35;
    camera.position.y += (Math.random() - 0.5) * shake * 0.25;
  }
  camTarget.copy(player.pos).addScaledVector(FWD, 7).add({ x: 0, y: 1.6 + look.pitch * 2, z: 0 });
  camera.lookAt(camTarget);
  camera.rotateZ(player.driftYaw * 0.6);          // 杩囧集渚у€?
  camera.fov += (62 + sk * 16 - camera.fov) * k;
  camera.updateProjectionMatrix();
  // 闃村奖鐩告満璺熼殢鐜╁
  sun.position.copy(player.pos).add({ x: 60, y: 110, z: 45 });
  sun.target.position.copy(player.pos);
  // 閫熷害鏅曞奖
  $('vignette').style.opacity = (sk * sk * 0.55).toFixed(2);
}

// ---- 涓诲惊鐜?----
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  pollInput(); // 姣忓抚杞杈撳叆锛欰UTO 娌归棬/闄€铻轰华涓嶄緷璧栦簨浠跺嵆鍙敓鏁?
  const shake = game.update(dt, input);
  updateCamera(dt, shake);
  dust.update(dt);
  smoke.update(dt);
  scenery.update(dt); // 椋庢満鍙剁墖绛夊満鏅姩鐢?
  if (composer.enabled) composer.render();
  else renderer.render(scene, camera);
}
animate();

// 璋冭瘯/娴嬭瘯閽╁瓙锛歎RL 甯?#autotest 鏃惰嚜鍔ㄨ蛋 寮€濮嬭嚜椹锯啋閫夐粯璁よ溅鈫掕繘鑷敱婕父
if (location.hash.includes('autotest')) {
  const t = setInterval(() => {
    if (window.game) {
      clearInterval(t);
      $('btn-start').click();
      document.querySelector('#carCards .car-card').click();
    }
  }, 300);
}
window.game = game; // 渚涜嚜鍔ㄥ寲娴嬭瘯鎿嶇旱鐜╁浣嶇疆/璇诲彇鐘舵€?
window.scene = scene; // 璋冭瘯閽╁瓙锛氬畾浣嶆覆鏌撳紓甯?
window.camera = camera;
window.renderer = renderer;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

console.log('[racing] ready. quality =', quality);
