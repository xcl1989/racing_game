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
  tex.anisotropy = 8;
  return tex;
}

// 数据贴图（法线/粗糙度）：不走 sRGB
function finishData(canvas, repeatX = 1, repeatY = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  return tex;
}

// 由灰度高度图生成切线空间法线贴图（Sobel）
function normalMapFromHeight(hc, strength = 1.5) {
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

// ---- 柏油路面：颜色图（512px，噪声+车辙+标线）+ 法线 + 粗糙度 ----
export function makeAsphaltTextures() {
  const [c, x] = makeCanvas(512, 512);
  x.fillStyle = '#3a3d42';
  x.fillRect(0, 0, 512, 512);
  noise(x, 512, 512, 9500, ['#33363b', '#43464c', '#2f3237', '#484b52', '#3d4046'], 1, 4);
  // 大块色斑（修补痕迹）
  for (let i = 0; i < 14; i++) {
    x.fillStyle = `rgba(${28 + Math.random() * 20 | 0},${30 + Math.random() * 20 | 0},35,0.25)`;
    x.beginPath();
    x.ellipse(Math.random() * 512, Math.random() * 512, 24 + Math.random() * 60,
      16 + Math.random() * 40, Math.random() * 3, 0, Math.PI * 2);
    x.fill();
  }
  // 细裂纹（随机短折线）
  x.strokeStyle = 'rgba(24,26,30,0.5)';
  for (let i = 0; i < 12; i++) {
    x.lineWidth = 1 + Math.random();
    x.beginPath();
    let px = Math.random() * 512, py = Math.random() * 512;
    x.moveTo(px, py);
    for (let k = 0; k < 5; k++) {
      px += (Math.random() - 0.5) * 60;
      py += (Math.random() - 0.5) * 60;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  // 车辙暗带（双轮迹更明显）
  x.fillStyle = 'rgba(0,0,0,0.16)';
  x.fillRect(104, 0, 52, 512);
  x.fillRect(356, 0, 52, 512);
  // 中央虚线 + 两侧白实线
  x.fillStyle = '#e8c93e';
  for (let y = 0; y < 512; y += 128) x.fillRect(248, y, 16, 68);
  x.fillStyle = '#e2e2e2';
  x.fillRect(16, 0, 12, 512);
  x.fillRect(484, 0, 12, 512);
  const map = finish(c);

  // 粗糙度：基础 0.82，车辙抛光更亮（更滑），标线区域更粗糙
  const [rc, rx] = makeCanvas(256, 256);
  rx.fillStyle = '#d1d1d1'; // 0.82
  rx.fillRect(0, 0, 256, 256);
  noise(rx, 256, 256, 3000, ['#c4c4c4', '#dcdcdc', '#cccccc', '#c9c9c9'], 1, 4);
  rx.fillStyle = '#b8b8b8'; // 车辙 ~0.72
  rx.fillRect(52, 0, 26, 256);
  rx.fillRect(178, 0, 26, 256);
  const roughness = finishData(rc);

  // 高度噪声 → 法线（256px 细颗粒）
  const [hc, hx] = makeCanvas(256, 256);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 256, 256);
  noise(hx, 256, 256, 9000, ['#6e6e6e', '#929292', '#7a7a7a', '#888888', '#a0a0a0'], 1, 2);
  // 粗颗粒骨料凹坑
  for (let i = 0; i < 500; i++) {
    hx.fillStyle = Math.random() < 0.5 ? '#6a6a6a' : '#969696';
    hx.beginPath();
    hx.arc(Math.random() * 256, Math.random() * 256, 1.5 + Math.random() * 3.5, 0, Math.PI * 2);
    hx.fill();
  }
  const normal = normalMapFromHeight(hc, 2.0);
  return { map, normal, roughness };
}

// ---- 土路肩：颜色 + 法线 ----
export function makeDirtTextures(repeat = 1) {
  const [c, x] = makeCanvas(256, 256);
  x.fillStyle = '#6a5a42';
  x.fillRect(0, 0, 256, 256);
  noise(x, 256, 256, 5200, ['#5d4e39', '#77654a', '#524434', '#807050', '#6b5b44'], 1, 4);
  // 干裂痕迹
  x.strokeStyle = 'rgba(50,40,28,0.35)';
  for (let i = 0; i < 18; i++) {
    x.lineWidth = 1 + Math.random() * 1.5;
    x.beginPath();
    let px = Math.random() * 256, py = Math.random() * 256;
    x.moveTo(px, py);
    for (let k = 0; k < 4; k++) {
      px += (Math.random() - 0.5) * 70;
      py += (Math.random() - 0.5) * 70;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  const map = finish(c, repeat, repeat);

  const [hc, hx] = makeCanvas(128, 128);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 128, 128);
  noise(hx, 128, 128, 3200, ['#707070', '#8e8e8e', '#7a7a7a', '#868686'], 1, 3);
  const normal = normalMapFromHeight(hc, 1.8);
  normal.repeat.set(repeat, repeat);
  return { map, normal };
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
export function makeSkyTexture() {
  const [c, x] = makeCanvas(1024, 512);
  // 垂直渐变：天顶深蓝 → 地平线浅蓝白（保持足够饱和度防过曝发白）
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#1d4da8');    // 天顶
  g.addColorStop(0.45, '#4a8ccc');
  g.addColorStop(0.8, '#aed0ec');
  g.addColorStop(1, '#dcebf6');    // 地平线（与雾色衔接）
  x.fillStyle = g;
  x.fillRect(0, 0, 1024, 256);
  // 地平线以下：地面反照（暗绿灰，供环境光下半球反射）
  const g2 = x.createLinearGradient(0, 256, 0, 512);
  g2.addColorStop(0, '#9db3a4');
  g2.addColorStop(0.25, '#54685a');
  g2.addColorStop(1, '#3a4a40');
  x.fillStyle = g2;
  x.fillRect(0, 256, 1024, 256);
  // 太阳方向烘焙一圈亮晕（克制：环境反射里的太阳高光，不做可视太阳）
  const sunX = 1024 * (0.5 - (-0.66) / (2 * Math.PI));
  const sg = x.createRadialGradient(sunX, 96, 2, sunX, 96, 150);
  sg.addColorStop(0, 'rgba(255,246,214,0.7)');
  sg.addColorStop(0.3, 'rgba(255,238,190,0.25)');
  sg.addColorStop(1, 'rgba(255,238,190,0)');
  x.fillStyle = sg;
  x.fillRect(sunX - 160, 0, 320, 260);
  // 平滑处理（双线性放大已足够柔）
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

// ---- 水面法线（两层滚动的细波纹）----
export function makeWaterNormal() {
  const [hc, hx] = makeCanvas(256, 256);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, 256, 256);
  // 长条形波纹（横向拉长的椭圆 = 水波走向感）
  for (let i = 0; i < 900; i++) {
    const bright = Math.random() < 0.5;
    hx.fillStyle = bright ? '#9a9a9a' : '#6e6e6e';
    hx.beginPath();
    hx.ellipse(Math.random() * 256, Math.random() * 256,
      6 + Math.random() * 22, 1.5 + Math.random() * 3,
      Math.random() * Math.PI, 0, Math.PI * 2);
    hx.fill();
  }
  const tex = normalMapFromHeight(hc, 1.2);
  tex.repeat.set(6, 6);
  return tex;
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
