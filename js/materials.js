// materials.js — v2.29 程序化 PBR 材质增强库
// 目标：把全场景"纯色塑料感"道具（护栏/路灯/看台/油桶/轮胎墙/龙门架/树干/桥…）
// 注入微表面细节：细节法线 + 粗糙度微变化图，按材质特征三档分类：
//   metal  — 金属拉丝 + 划痕（metalness ≥ 0.45）
//   grain  — 橡胶/混凝土/磨砂颗粒（roughness ≥ 0.82）
//   satin  — 涂漆/塑料微凸斑（其余）
// 全部 256px 程序化贴图 + 单例缓存：三张贴图全场景共享，显存与 CPU 成本可忽略。
// 注入原则（防误伤）：
//   · 已有 map/normalMap/roughnessMap 的材质不动（路面/建筑/植被已重制）
//   · MeshPhysicalMaterial（车漆/玻璃）不动——已有清漆配方
//   · transparent / 带 onBeforeCompile 的材质不动（水面/天空等自定义 shader）
import * as THREE from 'three';
import { normalMapFromHeight } from './textures.js';

const _cache = {};

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function finishData(canvas, repeat = 8) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

// —— 三种高度场（256px，环绕平铺：噪声天然随机，接缝用低幅掩盖）——
function paintDetailHeight(x, S, kind) {
  x.fillStyle = '#808080';
  x.fillRect(0, 0, S, S);
  if (kind === 'metal') {
    // 水平拉丝条纹 + 随机短划痕（凹=暗）
    for (let y = 0; y < S; y += 1) {
      const v = 128 + Math.sin(y * 1.7) * 6 + Math.sin(y * 0.53 + 1.2) * 9
        + (Math.random() - 0.5) * 10;
      x.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      x.fillRect(0, y, S, 1);
    }
    x.strokeStyle = 'rgba(60,60,60,0.55)';
    for (let i = 0; i < 90; i++) {
      const px = Math.random() * S, py = Math.random() * S;
      const l = 6 + Math.random() * 40;
      x.lineWidth = Math.random() < 0.3 ? 1.6 : 0.7;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + l, py + (Math.random() - 0.5) * 3); x.stroke();
    }
  } else if (kind === 'grain') {
    // 细密颗粒 + 少量凹坑（橡胶/混凝土/磨砂铸件）
    for (let i = 0; i < S * 26; i++) {
      const v = 96 + Math.random() * 64;
      x.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},0.5)`;
      x.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    for (let i = 0; i < 260; i++) {
      x.fillStyle = 'rgba(70,70,70,0.5)';
      x.beginPath();
      x.arc(Math.random() * S, Math.random() * S, 1 + Math.random() * 2.4, 0, Math.PI * 2);
      x.fill();
    }
  } else {
    // satin：微凸软斑 + 抛光轨迹（涂漆/塑料的橘皮与流痕）
    for (let i = 0; i < 70; i++) {
      const px = Math.random() * S, py = Math.random() * S, r = 6 + Math.random() * 26;
      const v = Math.random() < 0.5 ? '255,255,255' : '96,96,96';
      const g = x.createRadialGradient(px, py, 1, px, py, r);
      g.addColorStop(0, `rgba(${v},0.14)`);
      g.addColorStop(1, `rgba(${v},0)`);
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
    x.strokeStyle = 'rgba(210,210,210,0.18)';
    for (let i = 0; i < 24; i++) {
      const px = Math.random() * S, py = Math.random() * S;
      x.lineWidth = 2 + Math.random() * 3;
      x.beginPath(); x.moveTo(px, py);
      x.bezierCurveTo(px + 30, py + (Math.random() - 0.5) * 60,
        px - 30, py + (Math.random() - 0.5) * 60, px + (Math.random() - 0.5) * 80, py + (Math.random() - 0.5) * 90);
      x.stroke();
    }
  }
}

// 粗糙度微变化图：基底接近纯白（≈ 不改变原 roughness），特征处偏离
function paintDetailRough(x, S, kind) {
  x.fillStyle = '#fbfbfb';
  x.fillRect(0, 0, S, S);
  if (kind === 'metal') {
    // 划痕处更粗糙（发雾）、抛光带更滑
    x.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 60; i++) {
      const px = Math.random() * S, py = Math.random() * S;
      const l = 8 + Math.random() * 44;
      x.lineWidth = Math.random() < 0.3 ? 2 : 1;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + l, py + (Math.random() - 0.5) * 3); x.stroke();
    }
    for (let i = 0; i < 30; i++) {
      const px = Math.random() * S, py = Math.random() * S;
      const g = x.createRadialGradient(px, py, 1, px, py, 10 + Math.random() * 26);
      g.addColorStop(0, 'rgba(190,190,190,0.5)');
      g.addColorStop(1, 'rgba(190,190,190,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, 40, 0, Math.PI * 2); x.fill();
    }
  } else if (kind === 'grain') {
    for (let i = 0; i < 140; i++) {
      const px = Math.random() * S, py = Math.random() * S, r = 4 + Math.random() * 22;
      const v = Math.random() < 0.5 ? '235,235,235' : '255,255,255';
      const g = x.createRadialGradient(px, py, 1, px, py, r);
      g.addColorStop(0, `rgba(${v},0.5)`);
      g.addColorStop(1, `rgba(${v},0)`);
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
  } else {
    for (let i = 0; i < 46; i++) {
      const px = Math.random() * S, py = Math.random() * S, r = 8 + Math.random() * 30;
      const v = Math.random() < 0.45 ? '215,215,215' : '255,255,255';
      const g = x.createRadialGradient(px, py, 1, px, py, r);
      g.addColorStop(0, `rgba(${v},0.35)`);
      g.addColorStop(1, `rgba(${v},0)`);
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
  }
}

function getDetail(kind) {
  if (_cache[kind]) return _cache[kind];
  const S = 256;
  const [hc, hx] = makeCanvas(S, S);
  paintDetailHeight(hx, S, kind);
  const [rc, rx] = makeCanvas(S, S);
  paintDetailRough(rx, S, kind);
  const normal = normalMapFromHeight(hc, kind === 'satin' ? 1.0 : 1.6);
  normal.anisotropy = 4;
  const roughness = finishData(rc);
  _cache[kind] = { normal, roughness };
  return _cache[kind];
}

// 三档强度（normalScale）
const STRENGTH = { metal: 0.55, grain: 0.6, satin: 0.32 };

/**
 * 给一个"纯色无贴图"的 Standard 材质注入微表面细节。
 * @returns {string|null} 注入的分类名；不适用返回 null
 */
export function enhancePropMaterial(mat) {
  if (!mat || !mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) return null;
  if (mat.userData._detailEnhanced) return mat.userData._detailKind || null;
  mat.userData._detailEnhanced = true;
  mat.userData._detailKind = null;
  if (mat.map || mat.normalMap || mat.roughnessMap) return null; // 已重制材质不动
  // ⚠️ Material.prototype.onBeforeCompile 默认是空函数（truthy），必须与原型比对，
  // 否则全场景材质都被误判为"自定义 shader"而跳过（首版 props=0 的根因）
  if (mat.transparent || mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  const kind = mat.metalness >= 0.45 ? 'metal'
    : (mat.roughness >= 0.82 ? 'grain' : 'satin');
  const d = getDetail(kind);
  mat.normalMap = d.normal;
  mat.roughnessMap = d.roughness;
  mat.normalScale = new THREE.Vector2(STRENGTH[kind], STRENGTH[kind]);
  // 磨砂/涂漆件压环境反射（默认 1.0 在 PMREM 天空下会发亮发假）；金属保留反射
  if (kind !== 'metal') mat.envMapIntensity = Math.min(mat.envMapIntensity ?? 1, 0.55);
  mat.userData._detailKind = kind;
  mat.needsUpdate = true;
  return kind;
}

/** 遍历一个对象的全部材质（含数组）逐个增强，返回命中数 */
export function enhanceObjectMaterials(obj) {
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  let n = 0;
  for (const m of mats) if (enhancePropMaterial(m)) n++;
  return n;
}
