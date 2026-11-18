// textures.js — 程序化 Canvas 贴图工厂（无需外部图片资源）
import * as THREE from 'three';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function noise(ctx, w, h, count, colors, sizeMin, sizeMax) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
    const s = sizeMin + Math.random() * (sizeMax - sizeMin);
    ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
}

function finish(canvas, repeatX = 1, repeatY = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 16; // v2.21.1: 8→16，掠射角远处标线更锐
  return tex;
}

// 数据贴图（法线/粗糙度）：不走 sRGB
function finishData(canvas, repeatX = 1, repeatY = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 16;
  return tex;
}

// 由灰度高度图生成切线空间法线贴图（Sobel）
export function normalMapFromHeight(hc, strength = 1.5) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const outC = document.createElement('canvas');
  outC.width = w; outC.height = h;
  const octx = outC.getContext('2d');
  const out = octx.createImageData(w, h);
  const at = (i, j) => src[(((i + h) % h) * w + ((j + w) % w)) * 4] / 255;
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const dx = (at(i, j - 1) - at(i, j + 1)) * strength;
      const dy = (at(i - 1, j) - at(i + 1, j)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const k = (i * w + j) * 4;
      out.data[k] = (dx * inv * 0.5 + 0.5) * 255;
      out.data[k + 1] = (dy * inv * 0.5 + 0.5) * 255;
      out.data[k + 2] = (inv * 0.5 + 0.5) * 255;
      out.data[k + 3] = 255;
    }
  }
  octx.putImageData(out, 0, 0);
  return finishData(outC);
}

// ================= 柏油路面（v2.21 3A 重制）=================
// 三路型（街道/高速/窄巷）共享同一 1024px 底图特征包，只差车辙布局与标线层：
//   细砂粒 → 中粒骨料簇 → 修补色斑 → 矩形沥青补丁（四周接缝）→ 井盖（双圈+高光弧）
//   → 主干+细枝裂纹 → 路缘暗化带（u=0/1 边缘 3.5%，ribbon 的 u 横跨整条路宽，全路型通用）
//   → 标线磨损侵蚀（在标线带内点噪露底，实线不再"塑料纯色"）
// 数据图（粗糙度/法线）与颜色图逐特征对齐：油渍更滑、补丁更糙、接缝凹槽、井盖微凸。
// 单例缓存：1024px 全套生成 ~80ms，track.js 多次调用与全图 ~20 段路共享一份实例
// （world.js v2.21 起 ribbon 不再 clone 贴图 —— 共享后 1024 反而比旧 512×20 份更省显存）。

const _roadTexCache = {};

function cloneCanvas(src) {
  const [c, x] = makeCanvas(src.width, src.height);
  x.drawImage(src, 0, 0);
  return c;
}

// 生成全路型共享的底图特征（位置只随机一次，三张图严格对齐）
// ⚠️ v2.21.2：道路 UV 纵向 1 v = 12m，canvas 纵向特征物理上被拉长 2 倍——
// 全部纵向尺寸按 1/2 定义，mip 后才不会拖成"云雾状长斑"
function genAsphaltFeatures(S) {
  return {
    patches: Array.from({ length: 6 }, () => ({
      x: Math.random() * S * 0.8, y: Math.random() * S * 0.8,
      w: S * (0.05 + Math.random() * 0.11), h: S * (0.02 + Math.random() * 0.04),
      dark: Math.random() < 0.5,
    })),
    manholes: Array.from({ length: 2 }, () => ({
      x: S * (0.18 + Math.random() * 0.64), y: Math.random() * S, r: S * 0.022,
    })),
    stains: Array.from({ length: 5 }, () => ({
      x: Math.random() * S, y: Math.random() * S,
      rx: S * (0.02 + Math.random() * 0.05), ry: S * (0.008 + Math.random() * 0.015),
      rot: Math.random() * 3,
    })),
    cracks: Array.from({ length: 14 }, () => {
      const pts = [];
      let px = Math.random() * S, py = Math.random() * S;
      pts.push([px, py]);
      for (let k = 0; k < 6; k++) {
        px += (Math.random() - 0.5) * S * 0.14;
        py += (Math.random() - 0.5) * S * 0.07; // 纵向步幅减半（同上补偿）
        pts.push([px, py]);
      }
      return pts;
    }),
  };
}

function paintAsphaltColor(x, S, F) {
  // v2.22 基底提亮：#3a3d42 偏黑与亮草地对比生硬，真实日晒沥青是中灰
  x.fillStyle = '#45484e';
  x.fillRect(0, 0, S, S);
  noise(x, S, S, S * S * 0.036, ['#3e4147', '#4e5158', '#3a3d43', '#525559', '#474a50'], 1, 3);
  noise(x, S, S, S * 7, ['#41454b', '#50555c', '#393d42', '#464a51'], 2, 6);
  // 大块修补色斑（v2.21.2：数量/透明度减半——远距 mip 后的"云雾斑"主源）
  for (let i = 0; i < 8; i++) {
    x.fillStyle = `rgba(${28 + Math.random() * 20 | 0},${30 + Math.random() * 20 | 0},35,0.12)`;
    x.beginPath();
    x.ellipse(Math.random() * S, Math.random() * S,
      S * 0.05 + Math.random() * S * 0.12, S * 0.015 + Math.random() * S * 0.04,
      Math.random() * 3, 0, Math.PI * 2);
    x.fill();
  }
  // 矩形沥青补丁（v2.22 教训：基底提亮后深色补丁对比暴涨成"幽灵矩形框"——
  // 3A 路面的真实感来自连续微变化，离散大特征在远距下永远是噪声。降到近隐只留接缝暗示）
  for (const p of F.patches) {
    x.fillStyle = p.dark ? 'rgba(52,56,62,0.16)' : 'rgba(94,99,106,0.14)';
    x.fillRect(p.x, p.y, p.w, p.h);
    x.strokeStyle = 'rgba(45,48,54,0.22)';
    x.lineWidth = 2;
    x.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
  }
  // 井盖：外圈 + 内圈盘 + 高光弧
  for (const m of F.manholes) {
    x.fillStyle = '#2d3136';
    x.beginPath(); x.arc(m.x, m.y, m.r, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#363b41';
    x.beginPath(); x.arc(m.x, m.y, m.r * 0.72, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.10)';
    x.lineWidth = Math.max(1, m.r * 0.14);
    x.beginPath(); x.arc(m.x, m.y, m.r * 0.86, -2.2, -0.6); x.stroke();
  }
  // 油渍（暗斑，粗糙度图对应更滑）
  for (const s of F.stains) {
    x.fillStyle = 'rgba(18,20,24,0.32)';
    x.beginPath();
    x.ellipse(s.x, s.y, s.rx, s.ry, s.rot, 0, Math.PI * 2);
    x.fill();
  }
  // 裂纹（主干折线）
  x.strokeStyle = 'rgba(22,24,28,0.55)';
  for (const pts of F.cracks) {
    x.lineWidth = 1 + Math.random() * 1.6;
    x.beginPath();
    x.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) x.lineTo(pts[k][0], pts[k][1]);
    x.stroke();
  }
  // 路缘暗化带：u=0/1 两边渐暗（贴近路缘石的天然污渍过渡）
  for (const gx of [0, 1]) {
    const g = gx === 0
      ? x.createLinearGradient(0, 0, S * 0.035, 0)
      : x.createLinearGradient(S, 0, S * 0.965, 0);
    g.addColorStop(0, 'rgba(12,14,16,0.42)');
    g.addColorStop(1, 'rgba(12,14,16,0)');
    x.fillStyle = g;
    x.fillRect(gx === 0 ? 0 : S * 0.965, 0, S * 0.035, S);
  }
}

function paintAsphaltRough(rx, S, F) {
  rx.fillStyle = '#d1d1d1'; // 基础 ~0.82
  rx.fillRect(0, 0, S, S);
  noise(rx, S, S, S * 24, ['#c4c4c4', '#dcdcdc', '#cccccc', '#c9c9c9'], 1, 4);
  // ⚠️ v2.21.1：油渍/补丁的粗糙度扰动大幅减弱——之前 α0.5 的镜面斑在阳光下
  // 反射暗色天空 = 路面大片"油渍黑斑"（用户实机报"还不如旧版"的主因）。
  for (const s of F.stains) { // 油渍微滑（只留近看可察觉的微妙变化）
    rx.fillStyle = 'rgba(150,150,150,0.22)';
    rx.beginPath();
    rx.ellipse(s.x / 2, s.y / 2, s.rx / 2, s.ry / 2, s.rot, 0, Math.PI * 2);
    rx.fill();
  }
  for (const p of F.patches) { // 补丁面微糙（v2.22 收敛防大块反光斑）
    rx.fillStyle = 'rgba(216,216,216,0.12)';
    rx.fillRect(p.x / 2, p.y / 2, p.w / 2, p.h / 2);
  }
  rx.fillStyle = '#dedede'; // 路缘带稍粗糙（原 0xe2 收半档）
  rx.fillRect(0, 0, S * 0.035, S);
  rx.fillRect(S * 0.965, 0, S * 0.035, S);
}

function paintAsphaltHeight(hx, S, F) {
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, S, S);
  // v2.21.1：细噪声密度减半+骨料减半——过密的高度细节在远距 mip 平均后
  // 会变成法线"脏斑"，远观反而不如旧版的轻纹理
  noise(hx, S, S, S * 40, ['#747474', '#8c8c8c', '#7a7a7a', '#868686'], 1, 2);
  for (let i = 0; i < S * 3; i++) { // 骨料凹坑/凸粒
    hx.fillStyle = Math.random() < 0.5 ? '#707070' : '#909090';
    hx.beginPath();
    hx.arc(Math.random() * S, Math.random() * S, 1 + Math.random() * 2.2, 0, Math.PI * 2);
    hx.fill();
  }
  for (const p of F.patches) { // 补丁面微凸 + 接缝凹槽
    const px = p.x / 2, py = p.y / 2, pw = p.w / 2, ph = p.h / 2;
    hx.fillStyle = '#878787';
    hx.fillRect(px, py, pw, ph);
    hx.strokeStyle = '#5f5f5f';
    hx.lineWidth = 2.5;
    hx.strokeRect(px, py, pw, ph);
  }
  for (const m of F.manholes) { // 井盖：外圈凹槽 + 盘面微凸
    const mx = m.x / 2, my = m.y / 2, mr = m.r / 2;
    hx.strokeStyle = '#585858';
    hx.lineWidth = 4;
    hx.beginPath(); hx.arc(mx, my, mr, 0, Math.PI * 2); hx.stroke();
    hx.fillStyle = '#8b8b8b';
    hx.beginPath(); hx.arc(mx, my, mr * 0.72, 0, Math.PI * 2); hx.fill();
  }
  hx.strokeStyle = '#6a6a6a'; // 裂纹微凹
  for (const pts of F.cracks) {
    hx.lineWidth = 1.5;
    hx.beginPath();
    hx.moveTo(pts[0][0] / 2, pts[0][1] / 2);
    for (let k = 1; k < pts.length; k++) hx.lineTo(pts[k][0] / 2, pts[k][1] / 2);
    hx.stroke();
  }
}

// 标线磨损侵蚀：在标线带内点底色噪点，实线变斑驳
// ⚠️ v2.21.1 收敛：旧参数(S*0.045, α0.25-0.75)噪点面积超过标线带本身，
// 远看标线消失 = "还不如旧版"。现在只轻微斑驳，保持远处锐利可读。
function wearMarkings(x, S, bands, count) {
  x.fillStyle = '#45484e';
  for (let i = 0; i < count; i++) {
    const b = bands[(Math.random() * bands.length) | 0];
    x.globalAlpha = 0.15 + Math.random() * 0.3;
    const w = 1 + Math.random() * 2.5;
    x.fillRect(b[0] * S + Math.random() * b[1] * S, Math.random() * S, w, w);
  }
  x.globalAlpha = 1;
}

// 车辙暗带：[中心u, 宽] 分数坐标
function paintTracks(x, S, tracks, alpha) {
  x.fillStyle = `rgba(0,0,0,${alpha})`;
  for (const [cx, w] of tracks) x.fillRect(cx * S, 0, w * S, S);
}

// 通用路面贴图打包：底图特征包 → 克隆画布 → 路型专属覆盖层 → 三张图
function buildRoadTextures(style) {
  const S = 1024, DS = 512;
  const F = genAsphaltFeatures(S);
  // 颜色图
  const [c, x] = makeCanvas(S, S);
  paintAsphaltColor(x, S, F);
  style.markings(x, S);
  const map = finish(c);
  // 粗糙度图（特征坐标 /2 对齐 512）
  const [rc, rx] = makeCanvas(DS, DS);
  paintAsphaltRough(rx, DS, F);
  paintTracks(rx, DS, style.tracks, 0.10); // 车辙抛光微滑（v2.21.1 从 0.18 收敛）
  const roughness = finishData(rc);
  // 高度图 → 法线
  const [hc, hx] = makeCanvas(DS, DS);
  paintAsphaltHeight(hx, DS, F);
  const normal = normalMapFromHeight(hc, 1.8); // v2.21.1 从 2.2 收敛：远距法线脏斑
  return { map, normal, roughness };
}

// ---- 街道：中央黄虚线 + 两侧白实线，双车辙 ----
const STYLE_STREET = {
  tracks: [[0.203, 0.102], [0.695, 0.102]],
  markings(x, S) {
    paintTracks(x, S, this.tracks, 0.16);
    x.fillStyle = '#ddc03e';
    // v2.21.1: 1 v = 12m —— 城市黄虚线 3m/3m（每贴图两组）
    for (const y of [0, S * 0.5]) x.fillRect(S * 0.484, y, S * 0.031, S * 0.25);
    x.fillStyle = '#e6e6e6';
    x.fillRect(S * 0.028, 0, S * 0.028, S);
    x.fillRect(S * 0.944, 0, S * 0.028, S);
    wearMarkings(x, S, [[0.482, 0.036], [0.028, 0.028], [0.944, 0.028]], S * 0.005);
  },
};

// ---- 高速：中央双黄实线 + 两条白虚线 + 白边线，四车辙 ----
const STYLE_HIGHWAY = {
  tracks: [[0.125, 0.078], [0.344, 0.078], [0.656, 0.078], [0.875, 0.078]],
  markings(x, S) {
    paintTracks(x, S, this.tracks, 0.13);
    x.fillStyle = '#dcbd3e';
    x.fillRect(S * 0.481, 0, S * 0.013, S);
    x.fillRect(S * 0.506, 0, S * 0.013, S);
    x.fillStyle = '#e6e6e6';
    // v2.21.1: 1 v = 12m —— 虚线画 3m/空 9m（真实高速标线比例，旧版 1.3m 间距像斑马线）
    x.fillRect(S * 0.256, 0, S * 0.024, S * 0.25);
    x.fillRect(S * 0.721, 0, S * 0.024, S * 0.25);
    x.fillRect(S * 0.024, 0, S * 0.027, S);
    x.fillRect(S * 0.949, 0, S * 0.027, S);
    wearMarkings(x, S, [[0.477, 0.046], [0.256, 0.024], [0.721, 0.024], [0.024, 0.027], [0.949, 0.027]], S * 0.006);
  },
};

// ---- 窄巷：无双黄线（中央细白虚线 + 两侧白实线），窄车辙 ----
const STYLE_LANE = {
  tracks: [[0.3125, 0.09], [0.598, 0.09]],
  markings(x, S) {
    paintTracks(x, S, this.tracks, 0.16);
    x.fillStyle = '#d6d6d6';
    // v2.21.1: 1 v = 12m —— 巷道白虚线 3m/9m（每贴图一组）
    x.fillRect(S * 0.486, 0, S * 0.024, S * 0.25);
    x.fillStyle = '#dedede';
    x.fillRect(S * 0.056, 0, S * 0.024, S);
    x.fillRect(S * 0.920, 0, S * 0.024, S);
    wearMarkings(x, S, [[0.486, 0.024], [0.056, 0.024], [0.920, 0.024]], S * 0.005);
  },
};

export function makeAsphaltTextures() {
  if (!_roadTexCache.street) _roadTexCache.street = buildRoadTextures(STYLE_STREET);
  return _roadTexCache.street;
}

export function makeHighwayTextures() {
  if (!_roadTexCache.highway) _roadTexCache.highway = buildRoadTextures(STYLE_HIGHWAY);
  return _roadTexCache.highway;
}

export function makeLaneTextures() {
  if (!_roadTexCache.lane) _roadTexCache.lane = buildRoadTextures(STYLE_LANE);
  return _roadTexCache.lane;
}

// ---- 土路（v2.21 升级）：车辙双凹槽（磨光发暗）+ 碎石颗粒 + 干裂纹 + 路缘草侵 ----
// 补齐粗糙度/法线（旧版只有颜色图，ribbon 端被迫回退纯粗糙度）
export function makeDirtTextures(repeat = 1) {
  if (_roadTexCache['dirt' + repeat]) return _roadTexCache['dirt' + repeat];
  const S = 512;
  const [c, x] = makeCanvas(S, S);
  x.fillStyle = '#6a5a42';
  x.fillRect(0, 0, S, S);
  noise(x, S, S, S * S * 0.08, ['#5d4e39', '#77654a', '#524434', '#807050', '#6b5b44'], 1, 4);
  // 干裂痕迹
  x.strokeStyle = 'rgba(50,40,28,0.35)';
  for (let i = 0; i < 20; i++) {
    x.lineWidth = 1 + Math.random() * 1.5;
    x.beginPath();
    let px = Math.random() * S, py = Math.random() * S;
    x.moveTo(px, py);
    for (let k = 0; k < 5; k++) {
      px += (Math.random() - 0.5) * S * 0.28;
      py += (Math.random() - 0.5) * S * 0.28;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  // 碎石颗粒（细亮点）
  for (let i = 0; i < 900; i++) {
    x.fillStyle = ['#8d7d60', '#998a6a', '#5a4c38'][(Math.random() * 3) | 0];
    x.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // 车辙双凹槽：磨光土色发暗 + 沿程拖痕
  for (const cx of [0.32, 0.68]) {
    const g = x.createLinearGradient((cx - 0.07) * S, 0, (cx + 0.07) * S, 0);
    g.addColorStop(0, 'rgba(40,32,22,0)');
    g.addColorStop(0.5, 'rgba(40,32,22,0.45)');
    g.addColorStop(1, 'rgba(40,32,22,0)');
    x.fillStyle = g;
    x.fillRect((cx - 0.07) * S, 0, S * 0.14, S);
    x.strokeStyle = 'rgba(46,38,26,0.35)';
    for (let i = 0; i < 26; i++) {
      const sx = (cx - 0.06 + Math.random() * 0.12) * S;
      const sy = Math.random() * S;
      x.lineWidth = 1 + Math.random();
      x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx, sy + 8 + Math.random() * 22); x.stroke();
    }
  }
  // 路缘草侵：两边绿斑
  for (const gx of [0, 1]) {
    const g = gx === 0
      ? x.createLinearGradient(0, 0, S * 0.08, 0)
      : x.createLinearGradient(S, 0, S * 0.92, 0);
    g.addColorStop(0, 'rgba(84,104,56,0.4)');
    g.addColorStop(1, 'rgba(84,104,56,0)');
    x.fillStyle = g;
    x.fillRect(gx === 0 ? 0 : S * 0.92, 0, S * 0.08, S);
  }
  const map = finish(c, repeat, repeat);

  // 粗糙度：车辙磨光更滑，碎石更糙
  const rs = 256;
  const [rc, rx] = makeCanvas(rs, rs);
  rx.fillStyle = '#c8c8c8';
  rx.fillRect(0, 0, rs, rs);
  noise(rx, rs, rs, rs * 40, ['#bdbdbd', '#d4d4d4', '#c8c8c8'], 1, 3);
  for (let i = 0; i < 260; i++) { // 碎石微亮
    rx.fillStyle = 'rgba(225,225,225,0.6)';
    rx.fillRect(Math.random() * rs, Math.random() * rs, 2, 2);
  }
  for (const cx of [0.32, 0.68]) { // 车辙抛光
    rx.fillStyle = 'rgba(160,160,160,0.55)';
    rx.fillRect((cx - 0.06) * rs, 0, rs * 0.12, rs);
  }
  const roughness = finishData(rc, repeat, repeat);

  // 高度 → 法线：车辙凹槽 + 碎石凸包 + 裂纹
  const hs = 256;
  const [hc, hx] = makeCanvas(hs, hs);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, hs, hs);
  noise(hx, hs, hs, hs * 90, ['#707070', '#8e8e8e', '#7a7a7a', '#868686'], 1, 3);
  for (let i = 0; i < 420; i++) { // 碎石凸包
    hx.fillStyle = Math.random() < 0.6 ? '#9a9a9a' : '#686868';
    hx.beginPath();
    hx.arc(Math.random() * hs, Math.random() * hs, 1 + Math.random() * 2.2, 0, Math.PI * 2);
    hx.fill();
  }
  for (const cx of [0.32, 0.68]) { // 车辙凹槽
    hx.fillStyle = '#666666';
    hx.fillRect((cx - 0.055) * hs, 0, hs * 0.11, hs);
  }
  const normal = normalMapFromHeight(hc, 1.9);
  normal.repeat.set(repeat, repeat);
  _roadTexCache['dirt' + repeat] = { map, normal, roughness };
  return _roadTexCache['dirt' + repeat];
}

// ---- 云朵（多个柔边白团叠加，加底部阴影更有体积感）----
export function makeCloudTexture() {
  const [c, x] = makeCanvas(256, 128);
  x.clearRect(0, 0, 256, 128);
  const puff = (cx, cy, r, a, tint = '255,255,255') => {
    const g = x.createRadialGradient(cx, cy, 1, cx, cy, r);
    g.addColorStop(0, `rgba(${tint},${a})`);
    g.addColorStop(1, `rgba(${tint},0)`);
    x.fillStyle = g;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  // 底部淡灰（云底阴影）
  puff(120, 92, 58, 0.5, '205,212,225');
  puff(160, 90, 46, 0.42, '205,212,225');
  // 主体白团
  puff(128, 70, 62, 0.88);
  puff(85, 78, 45, 0.72);
  puff(172, 76, 48, 0.72);
  puff(105, 60, 40, 0.62);
  puff(150, 60, 38, 0.58);
  puff(112, 50, 30, 0.5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 草地（1024px：色块起伏 + 细密草叶笔触）----
export function makeGrassTexture(repeat = 140) {
  const [c, x] = makeCanvas(1024, 1024);
  x.fillStyle = '#5d7a50';
  x.fillRect(0, 0, 1024, 1024);
  noise(x, 1024, 1024, 26000, ['#547040', '#68855a', '#4d6642', '#71905d', '#7c9a68', '#5e7d4e'], 1, 5);
  // 短笔触草叶（随机方向细线）
  for (let i = 0; i < 9000; i++) {
    const px = Math.random() * 1024, py = Math.random() * 1024;
    const l = 3 + Math.random() * 6;
    const a = Math.random() * Math.PI;
    x.strokeStyle = ['rgba(110,150,88,0.5)', 'rgba(70,100,58,0.5)', 'rgba(128,158,100,0.4)'][(Math.random() * 3) | 0];
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
    x.stroke();
  }
  for (let i = 0; i < 30; i++) {
    x.fillStyle = `rgba(${60 + Math.random() * 40 | 0},${95 + Math.random() * 45 | 0},55,0.13)`;
    x.beginPath();
    x.arc(Math.random() * 1024, Math.random() * 1024, 60 + Math.random() * 140, 0, Math.PI * 2);
    x.fill();
  }
  // 枯黄斑（自然草地的不均匀感）
  for (let i = 0; i < 12; i++) {
    x.fillStyle = 'rgba(150,140,70,0.09)';
    x.beginPath();
    x.arc(Math.random() * 1024, Math.random() * 1024, 40 + Math.random() * 90, 0, Math.PI * 2);
    x.fill();
  }
  const tex = finish(c, repeat, repeat);
  tex.anisotropy = 16;
  return tex;
}

// ---- 格子旗（起点横幅）----
export function makeCheckerTexture() {
  const [c, x] = makeCanvas(128, 64);
  const n = 8;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n / 2; j++) {
      x.fillStyle = (i + j) % 2 ? '#111' : '#eee';
      x.fillRect(i * 16, j * 16, 16, 16);
    }
  return finish(c);
}

// ---- 楼房立面（白天玻璃幕墙：更丰富的楼层细节 + 立面色带）----
export function makeWindowsTexture() {
  const [c, x] = makeCanvas(128, 256);
  // 立面基底：竖向色带（不同楼层微差）
  for (let by = 0; by < 256; by += 32) {
    const t = 0.85 + Math.random() * 0.3;
    x.fillStyle = `rgb(${(69 * t) | 0},${(80 * t) | 0},${(96 * t) | 0})`;
    x.fillRect(0, by, 128, 32);
  }
  noise(x, 128, 256, 800, ['#4d586a', '#5d6878', '#616c7e'], 2, 5);
  // 楼层分隔线
  x.fillStyle = 'rgba(30,34,42,0.55)';
  for (let by = 0; by < 256; by += 32) x.fillRect(0, by + 28, 128, 4);
  for (let by = 0; by < 256; by += 32) {
    for (let wx = 5; wx < 122; wx += 13) {
      const r = Math.random();
      x.fillStyle = r < 0.08 ? '#ffe9b0'           // 亮窗（少数）
        : r < 0.5 ? '#7c8ba0'                      // 反光玻璃
        : '#3d4656';                               // 暗玻璃
      x.fillRect(wx, by + 5, 8, 18);
      // 窗框高光（顶部一线反光）
      x.fillStyle = 'rgba(255,255,255,0.18)';
      x.fillRect(wx, by + 5, 8, 2);
    }
  }
  return finish(c);
}

// ---- 天穹 equirect 渐变（背景 + 环境反射共用）----
// 参数化绘制：天气系统按同一套 stop 动态重绘（晴/多云/阴/雨共用此函数）
export const SKY_SUNNY = {
  zenith: '#1d4da8', mid: '#4a8ccc', horizon: '#dcebf6',
  g1: '#9db3a4', g2: '#54685a', g3: '#3a4a40',
  sunX: 0.605, sunGlow: 0.7, // 与原版一致：0.5 + 0.66/(2π)（太阳 sprite 在东南高空）
};

export function paintSky(ctx, p) {
  // 垂直渐变：天顶 → 地平线（保持足够饱和度防过曝发白）
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, p.zenith);
  g.addColorStop(0.45, p.mid);
  g.addColorStop(0.8, p.horizon);
  g.addColorStop(1, p.horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 256);
  // 地平线以下：地面反照（供环境光下半球反射）
  const g2 = ctx.createLinearGradient(0, 256, 0, 512);
  g2.addColorStop(0, p.g1);
  g2.addColorStop(0.25, p.g2);
  g2.addColorStop(1, p.g3);
  ctx.fillStyle = g2;
  ctx.fillRect(0, 256, 1024, 512 - 256);
  // 太阳方向烘焙一圈亮晕（克制：环境反射里的太阳高光，不做可视太阳）
  // sunX 未传时回落晴天方位（weather.js 混合只传颜色与 sunGlow）
  const sunX = 1024 * (p.sunX ?? SKY_SUNNY.sunX);
  if (p.sunGlow > 0.01) {
    const sg = ctx.createRadialGradient(sunX, 96, 2, sunX, 96, 150);
    sg.addColorStop(0, `rgba(255,246,214,${p.sunGlow})`);
    sg.addColorStop(0.3, `rgba(255,238,190,${p.sunGlow * 0.36})`);
    sg.addColorStop(1, 'rgba(255,238,190,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(sunX - 160, 0, 320, 260);
  }
}

// 可重绘天穹：weather.js 在天气过渡时反复 repaint（背景与 PMREM 环境共用同一张 tex）
export function createSkyPainter() {
  const [c, ctx] = makeCanvas(1024, 512);
  paintSky(ctx, SKY_SUNNY);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return {
    tex, canvas: c,
    repaint(p) {
      paintSky(ctx, p);
      tex.needsUpdate = true;
    },
  };
}

// 兼容旧接口：只取一张默认晴空贴图
export function makeSkyTexture() {
  return createSkyPainter().tex;
}

// ---- 水面法线（v2.24 加富：多尺度长条波纹叠加，单层滚动也有干涉感）----
export function makeWaterNormal() {
  const [hc, hx] = makeCanvas(512, 512);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 512, 512);
  // 三档波纹：长主浪 / 中碎浪 / 细涟漪（长条椭圆 = 水波走向感）
  const ripple = (n, lenMin, lenMax, th, alpha) => {
    for (let i = 0; i < n; i++) {
      const bright = Math.random() < 0.5;
      hx.fillStyle = bright
        ? `rgba(168,168,168,${alpha})`
        : `rgba(88,88,88,${alpha})`;
      hx.beginPath();
      hx.ellipse(Math.random() * 512, Math.random() * 512,
        lenMin + Math.random() * (lenMax - lenMin),
        th * (0.6 + Math.random() * 0.8),
        Math.random() * Math.PI, 0, Math.PI * 2);
      hx.fill();
    }
  };
  ripple(240, 40, 110, 4.5, 0.5);  // 主浪
  ripple(420, 12, 34, 2.2, 0.42);  // 中浪
  ripple(900, 4, 12, 1.1, 0.30);   // 细涟漪
  const tex = normalMapFromHeight(hc, 1.3);
  tex.repeat.set(6, 6);
  return tex;
}

// ---- 远山岩壁（v2.24：层理岩 + 碎屑噪声，打破"光滑渐变帐篷"感）----
export function makeMountainTexture() {
  const [c, x] = makeCanvas(512, 512);
  // 基底：亮冷灰岩（vertexColors/实例色还会再乘，这里必须保持高亮度防三层相乘变黑墙）
  x.fillStyle = '#a8aea8';
  x.fillRect(0, 0, 512, 512);
  // 水平层理带（微倾斜，深浅交替）——岩壁沉积层理的第一读感
  let yy = 0;
  while (yy < 512) {
    const th = 8 + Math.random() * 26;
    const l = 0.88 + Math.random() * 0.26;
    x.fillStyle = `rgba(${(148 * l) | 0},${(156 * l) | 0},${(146 * l) | 0},0.5)`;
    x.fillRect(0, yy, 512, th);
    yy += th;
  }
  // 斜向蚀沟（雨水冲刷的竖向浅沟，随 v 有拉伸）
  for (let i = 0; i < 70; i++) {
    const px = Math.random() * 512;
    const g = x.createLinearGradient(px, 0, px + (Math.random() - 0.5) * 60, 512);
    const a = 0.10 + Math.random() * 0.14;
    g.addColorStop(0, `rgba(96,104,98,${a})`);
    g.addColorStop(1, `rgba(178,184,176,${a})`);
    x.fillStyle = g;
    x.fillRect(px - 3, 0, 6 + Math.random() * 10, 512);
  }
  // 岩屑噪点
  noise(x, 512, 512, 15000,
    ['#9aa19b', '#b4bbb4', '#8a928c', '#c0c6c0', '#a0a79f'], 1, 4);
  // 植被斑块（山脚长绿苔/矮林：v 大（贴地）区域偏绿）
  for (let i = 0; i < 90; i++) {
    const px = Math.random() * 512, py = 300 + Math.random() * 212;
    x.fillStyle = `rgba(${58 + Math.random() * 30 | 0},${92 + Math.random() * 36 | 0},58,0.22)`;
    x.beginPath();
    x.ellipse(px, py, 14 + Math.random() * 36, 10 + Math.random() * 26, 0, 0, Math.PI * 2);
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function makeMountainNormal() {
  const [hc, hx] = makeCanvas(512, 512);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 512, 512);
  // 层理凹凸：水平暗条（凹槽）
  let yy = 0;
  while (yy < 512) {
    const th = 6 + Math.random() * 20;
    hx.fillStyle = Math.random() < 0.5 ? 'rgba(120,120,120,0.6)' : 'rgba(140,140,140,0.6)';
    hx.fillRect(0, yy, 512, th);
    yy += th + Math.random() * 10;
  }
  // 蚀沟竖条
  for (let i = 0; i < 60; i++) {
    const px = Math.random() * 512;
    hx.fillStyle = 'rgba(90,90,90,0.35)';
    hx.fillRect(px, 0, 3 + Math.random() * 7, 512);
  }
  // 碎石噪点
  noise(hx, 512, 512, 12000,
    ['rgba(140,140,140,0.5)', 'rgba(110,110,110,0.5)'], 1, 5);
  return normalMapFromHeight(hc, 1.6);
}

// ================= 城市立面（v2.25 楼群重制）=================
// tile = 4 层 × 8 窗列（512px）。消费方按楼高分桶 clone 后调 repeat：
// repeat.y = 楼高/12.8（每层恒定 3.2m）、repeat.x = 2（每窗列 1.3~2m）。
// ⚠️ repeat 是共享可变状态（血泪坑 31）——必须 clone 后再改。
export function makeFacadeTexture() {
  const [c, x] = makeCanvas(512, 512);
  // 基底：亮暖混凝土（instanceColor 会乘色调出暖白/砖红/灰蓝等变化）
  x.fillStyle = '#b6b1a8';
  x.fillRect(0, 0, 512, 512);
  for (let f = 0; f < 4; f++) {
    const fy = f * 128;
    // 层间楼板带（阴影 + 高光边）
    x.fillStyle = 'rgba(92,88,80,0.5)';
    x.fillRect(0, fy + 118, 512, 10);
    x.fillStyle = 'rgba(255,255,255,0.22)';
    x.fillRect(0, fy + 114, 512, 3);
    for (let wcol = 0; wcol < 8; wcol++) {
      const wx = wcol * 64;
      // 窗洞：框 + 玻璃（冷灰蓝反光，亮度随机）
      x.fillStyle = '#6e6a62';
      x.fillRect(wx + 12, fy + 30, 42, 72);       // 框
      const gb = 0.8 + Math.random() * 0.4;
      const gg = x.createLinearGradient(0, fy + 33, 0, fy + 99);
      gg.addColorStop(0, `rgb(${(138 * gb) | 0},${(158 * gb) | 0},${(168 * gb) | 0})`);
      gg.addColorStop(1, `rgb(${(94 * gb) | 0},${(110 * gb) | 0},${(120 * gb) | 0})`);
      x.fillStyle = gg;
      x.fillRect(wx + 15, fy + 33, 36, 66);       // 玻璃
      if (Math.random() < 0.3) {                   // 半拉百叶
        x.fillStyle = 'rgba(208,212,214,0.85)';
        x.fillRect(wx + 15, fy + 33, 36, 30);
      }
      // 窗台高光 + 窗下污渍流痕
      x.fillStyle = 'rgba(255,255,255,0.35)';
      x.fillRect(wx + 12, fy + 102, 42, 3);
      x.fillStyle = 'rgba(70,66,58,0.10)';
      x.fillRect(wx + 16, fy + 105, 34, 10);
    }
  }
  // 全脸细噪 + 竖向雨水痕
  noise(x, 512, 512, 6000, ['rgba(120,116,108,0.25)', 'rgba(210,206,196,0.25)'], 1, 3);
  for (let i = 0; i < 26; i++) {
    x.fillStyle = 'rgba(96,92,84,0.07)';
    x.fillRect(Math.random() * 512, 0, 2 + Math.random() * 5, 512);
  }
  return finish(c);
}

// 立面发光图（夜里亮窗）：黑底 + 随机暖光窗（与颜色图窗位对齐）
export function makeFacadeEmissive() {
  const [c, x] = makeCanvas(512, 512);
  x.fillStyle = '#000';
  x.fillRect(0, 0, 512, 512);
  for (let f = 0; f < 4; f++) {
    const fy = f * 128;
    for (let wcol = 0; wcol < 8; wcol++) {
      if (Math.random() >= 0.34) continue; // 34% 窗亮灯
      const wx = wcol * 64;
      const warm = Math.random() < 0.75;
      x.fillStyle = warm ? '#ffd98a' : '#cfe4ee';
      x.globalAlpha = 0.65 + Math.random() * 0.35;
      x.fillRect(wx + 15, fy + 33, 36, 66);
      x.globalAlpha = 1;
    }
  }
  return finish(c);
}

// 玻璃幕墙：竖向幕墙肋 + 横向层间带 + 蓝绿玻璃渐变（repeat.y = 楼高/10）
export function makeGlassTexture() {
  const [c, x] = makeCanvas(512, 512);
  const gg = x.createLinearGradient(0, 0, 0, 512);
  gg.addColorStop(0, '#9fc2d4');
  gg.addColorStop(0.5, '#7fa6b8');
  gg.addColorStop(1, '#6d94a8');
  x.fillStyle = gg;
  x.fillRect(0, 0, 512, 512);
  // 面板亮度微差（真实幕墙逐块反光不同）
  for (let i = 0; i < 18; i++) {
    const px = (Math.random() * 6 | 0) * 85, py = (Math.random() * 3 | 0) * 170;
    x.fillStyle = `rgba(${180 + Math.random() * 40 | 0},${205 + Math.random() * 30 | 0},220,0.12)`;
    x.fillRect(px + 4, py + 10, 77, 150);
  }
  // 斜向天空反光带
  const sh = x.createLinearGradient(80, 0, 420, 512);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(0.45, 'rgba(255,255,255,0.20)');
  sh.addColorStop(0.55, 'rgba(255,255,255,0.20)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = sh;
  x.fillRect(0, 0, 512, 512);
  // 竖向幕墙肋（6 列）
  x.fillStyle = '#6b7680';
  for (let i = 0; i < 6; i++) x.fillRect(i * 85 + 81, 0, 5, 512);
  // 横向层间带（3 行：深色楼板层）
  x.fillStyle = '#5d6870';
  for (let i = 0; i < 3; i++) x.fillRect(0, i * 170 + 162, 512, 12);
  x.fillStyle = 'rgba(255,255,255,0.25)';
  for (let i = 0; i < 3; i++) x.fillRect(0, i * 170 + 160, 512, 2);
  return finish(c);
}

// ---- 叶丛斑驳贴图（树冠/针叶共用：亮底斑驳，instanceColor 主导色调）----
export function makeFoliageTexture() {
  const [c, x] = makeCanvas(256, 256);
  x.fillStyle = '#e8eed8';
  x.fillRect(0, 0, 256, 256);
  // 深浅叶团簇（无规则，UV 畸形也无妨——只要斑驳噪声）
  for (let i = 0; i < 380; i++) {
    const g = 0.55 + Math.random() * 0.45;
    x.fillStyle = `rgba(${(120 * g) | 0},${(150 * g) | 0},${(96 * g) | 0},0.5)`;
    x.beginPath();
    x.ellipse(Math.random() * 256, Math.random() * 256,
      6 + Math.random() * 22, 5 + Math.random() * 16, Math.random() * Math.PI, 0, Math.PI * 2);
    x.fill();
  }
  // 高光叶尖 + 暗部孔洞
  for (let i = 0; i < 500; i++) {
    x.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,240,0.5)' : 'rgba(40,56,30,0.4)';
    x.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  return finish(c);
}

// ---- 草簇（透明背景交叉面片用：几笔叶片 + 底部实心）----
export function makeTuftTexture() {
  const [c, x] = makeCanvas(64, 64);
  x.clearRect(0, 0, 64, 64);
  // 底部草丛基座
  const g = x.createLinearGradient(0, 64, 0, 34);
  g.addColorStop(0, 'rgba(74,104,58,0.95)');
  g.addColorStop(1, 'rgba(74,104,58,0)');
  x.fillStyle = g;
  x.fillRect(10, 34, 44, 30);
  // 叶片（细长三角笔触）
  for (let i = 0; i < 14; i++) {
    const bx = 14 + Math.random() * 36;
    const top = 4 + Math.random() * 16;
    const lean = (Math.random() - 0.5) * 16;
    const shade = 90 + Math.random() * 70 | 0;
    x.fillStyle = `rgba(${(shade * 0.62) | 0},${shade},${(shade * 0.55) | 0},0.92)`;
    x.beginPath();
    x.moveTo(bx - 1.6, 60);
    x.lineTo(bx + 1.6, 60);
    x.lineTo(bx + lean, top);
    x.closePath();
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 广告牌文案贴图 ----
export function makeBillboardTexture(main, sub, bg = '#1a2a44', accent = '#7ee0ff') {
  const [c, x] = makeCanvas(256, 128);
  x.fillStyle = bg;
  x.fillRect(0, 0, 256, 128);
  // 边框
  x.strokeStyle = accent;
  x.lineWidth = 5;
  x.strokeRect(6, 6, 244, 116);
  // 主文案
  x.fillStyle = '#ffffff';
  x.font = 'bold 34px "Segoe UI", "PingFang SC", sans-serif';
  x.textAlign = 'center';
  x.fillText(main, 128, 62);
  x.fillStyle = accent;
  x.font = '20px Consolas, monospace';
  x.fillText(sub, 128, 96);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 飞鸟剪影（V 形）----
export function makeBirdTexture() {
  const [c, x] = makeCanvas(64, 32);
  x.clearRect(0, 0, 64, 32);
  x.strokeStyle = 'rgba(25,32,40,0.9)';
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(6, 22);
  x.quadraticCurveTo(20, 6, 32, 18);
  x.quadraticCurveTo(44, 6, 58, 22);
  x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 太阳/辉光 sprite 贴图 ----
export function makeGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const [c, x] = makeCanvas(128, 128);
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,244,200,0.55)');
  g.addColorStop(1, outer);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 车顶条纹贴图（装饰可选）----
export function makeStripeTexture(base = '#c8102e', stripe = '#f2f2f2') {
  const [c, x] = makeCanvas(64, 64);
  x.fillStyle = base;
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = stripe;
  x.fillRect(26, 0, 4, 64);
  x.fillRect(34, 0, 4, 64);
  return finish(c);
}

// ---- 农田（浅灰基底 + 犁沟条纹：用 instanceColor 染成麦田/青苗/耕地）----
export function makeFieldTexture() {
  const [c, x] = makeCanvas(256, 256);
  x.fillStyle = '#c9c9c9';
  x.fillRect(0, 0, 256, 256);
  noise(x, 256, 256, 3200, ['#bdbdbd', '#d4d4d4', '#c4c4c4', '#dcdcdc'], 1, 4);
  // 犁沟条纹（水平暗线，随贴图平铺出垄向）
  x.fillStyle = 'rgba(90,90,90,0.35)';
  for (let y = 4; y < 256; y += 16) x.fillRect(0, y, 256, 5);
  x.fillStyle = 'rgba(255,255,255,0.18)';
  for (let y = 9; y < 256; y += 16) x.fillRect(0, y, 256, 2);
  // 边缘杂草噪声
  for (let i = 0; i < 200; i++) {
    x.fillStyle = 'rgba(70,80,50,0.25)';
    x.fillRect(Math.random() * 256, Math.random() * 256, 2, 3);
  }
  const tex = finish(c);
  tex.repeat.set(3, 3);
  return tex;
}

// ---- v2.15 真实化：草地贴图 V2（有机多尺度色块，去"马赛克方块"感）----
// 与旧版差异：大/中尺度斑全部用径向渐变软边（且环绕平铺防接缝），
// 微噪声压低对比；草叶笔触降不透明度。平铺后是"草原色块"而非"像素方格"。
export function makeGrassTextureV2(repeat = 170) {
  const [c, x] = makeCanvas(1024, 1024);
  const W = 1024;
  x.fillStyle = '#57744b';
  x.fillRect(0, 0, W, W);
  // 环绕平铺的软斑：在 (±W, ±W) 九宫格都画一遍，接缝处无断裂
  const softWrap = (cx, cy, r, rgb, a) => {
    for (const ox of [-W, 0, W]) for (const oy of [-W, 0, W]) {
      const px = cx + ox, py = cy + oy;
      if (px + r < 0 || px - r > W || py + r < 0 || py - r > W) continue;
      const g = x.createRadialGradient(px, py, r * 0.12, px, py, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = g;
      x.fillRect(px - r, py - r, r * 2, r * 2);
    }
  };
  const GREENS = ['70,98,58', '96,128,74', '58,84,46', '112,134,80', '84,108,60', '122,142,88', '64,90,44'];
  const pick = () => GREENS[(Math.random() * GREENS.length) | 0];
  // 大尺度地块（草原色块起伏）
  for (let i = 0; i < 26; i++) {
    softWrap(Math.random() * W, Math.random() * W, 120 + Math.random() * 240, pick(), 0.10 + Math.random() * 0.12);
  }
  // 中尺度斑（草地自然斑块）
  for (let i = 0; i < 80; i++) {
    softWrap(Math.random() * W, Math.random() * W, 22 + Math.random() * 58, pick(), 0.08 + Math.random() * 0.10);
  }
  // 枯黄斑（少量，软边）
  for (let i = 0; i < 10; i++) {
    softWrap(Math.random() * W, Math.random() * W, 40 + Math.random() * 110, '152,142,84', 0.06 + Math.random() * 0.07);
  }
  // 微噪声（低对比，只做颗粒不做格子）
  noise(x, W, W, 15000, ['#516e46', '#5e7c50', '#4f6a44', '#617e54', '#59774d', '#647f56'], 1, 3);
  // 草叶笔触（降对比）
  for (let i = 0; i < 5200; i++) {
    const px = Math.random() * W, py = Math.random() * W;
    const l = 3 + Math.random() * 6, a = Math.random() * Math.PI;
    x.strokeStyle = ['rgba(104,142,84,0.35)', 'rgba(64,94,54,0.35)', 'rgba(124,152,96,0.3)'][(Math.random() * 3) | 0];
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
    x.stroke();
  }
  const tex = finish(c, repeat, repeat);
  tex.anisotropy = 16;
  return tex;
}

// ---- v2.15 真实化：草地法线贴图（草丛团块起伏，阳光下有细碎明暗）----
export function makeGrassNormal(repeat = 800) {
  const [hc, hx] = makeCanvas(512, 512);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 512, 512);
  const W = 512;
  const bumpWrap = (cx, cy, r, bright, a) => {
    for (const ox of [-W, 0, W]) for (const oy of [-W, 0, W]) {
      const px = cx + ox, py = cy + oy;
      if (px + r < 0 || px - r > W || py + r < 0 || py - r > W) continue;
      const g = hx.createRadialGradient(px, py, r * 0.1, px, py, r);
      g.addColorStop(0, bright ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
      g.addColorStop(1, 'rgba(128,128,128,0)');
      // 用 source-over 叠灰度：亮团向 255 推、暗团向 0 拉（近似）
      hx.fillStyle = g;
      hx.globalCompositeOperation = bright ? 'lighter' : 'multiply';
      hx.fillRect(px - r, py - r, r * 2, r * 2);
    }
  };
  hx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 110; i++) {
    bumpWrap(Math.random() * W, Math.random() * W, 8 + Math.random() * 34, Math.random() < 0.5, 0.10 + Math.random() * 0.10);
  }
  hx.globalCompositeOperation = 'source-over';
  noise(hx, W, W, 7000, ['#7a7a7a', '#868686', '#767676', '#8a8a8a'], 1, 2);
  // v2.29 高频草叶压痕：中频团块之外补一层细密短划痕，近看地面不再糊成一片
  for (let i = 0; i < 3000; i++) {
    const px = Math.random() * W, py = Math.random() * W;
    const l = 2 + Math.random() * 4, a = Math.random() * Math.PI;
    hx.strokeStyle = Math.random() < 0.5 ? 'rgba(155,155,155,0.55)' : 'rgba(92,92,92,0.55)';
    hx.lineWidth = 1;
    hx.beginPath();
    hx.moveTo(px, py);
    hx.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
    hx.stroke();
  }
  const tex = normalMapFromHeight(hc, 1.25); // v2.29 从 1.1 提升：配合高频层整体立体感
  tex.repeat.set(repeat, repeat);
  return tex;
}

