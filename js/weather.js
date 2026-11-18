// weather.js — 动态天气系统：晴 / 多云 / 阴 / 雨
// 联动五件事：
//   1. 天穹重绘（painter.repaint）+ PMREM 环境重烘（光照与背景保持同源）
//   2. 太阳平行光 / 半球光强度与色温
//   3. 雾颜色与浓度（fogNear/fogFar）
//   4. 渲染曝光 toneMappingExposure + 云层透明度/染色 + 太阳 sprite 淡出
//   5. 雨粒子强度 + 雨声 + 路面湿滑系数（wet，main.js 转交给 player）
// 过渡用 smoothstep 缓动，重绘/重烘按 0.25s 节流（只在过渡期间发生）
import * as THREE from 'three';

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const C = (hex) => new THREE.Color(hex);

// 天气参数表（sky 为天穹渐变 stop，其余为灯光/雾/后期）
export const WEATHER_TYPES = {
  sunny: {
    label: '晴',
    sky: { zenith: '#1d4da8', mid: '#3f86cc', horizon: '#e2edf4', g1: '#9db3a4', g2: '#54685a', g3: '#3a4a40', sunGlow: 0.7 },
    // v2.13 Forza 级晴天观感：黄金时刻更亮更饱（太阳/曝光/半球同步抬）
    // v2.22：太阳再暖再强一档 + 环境对比加深（阴影更有戏，直射面更金）
    sunI: 2.15, sunColor: 0xffdca0, hemiI: 0.58, hemiSky: 0xbfd9ff, hemiGnd: 0x556a40,
    fogColor: 0xd7e9f5, fogNear: 340, fogFar: 2700, exp: 1.07,
    cloudMul: 1.0, cloudTint: 0xffffff, sunSprite: 1.0,
    rain: 0, wet: 0,
  },
  cloudy: {
    label: '多云',
    sky: { zenith: '#3d6da8', mid: '#6d97c4', horizon: '#c2d3dd', g1: '#8fa094', g2: '#4e5e52', g3: '#38443e', sunGlow: 0.3 },
    sunI: 1.25, sunColor: 0xfff0d8, hemiI: 0.68, hemiSky: 0xc4d4e4, hemiGnd: 0x54604c,
    fogColor: 0xc4d2da, fogNear: 280, fogFar: 2100, exp: 0.94,
    cloudMul: 1.7, cloudTint: 0xf0f2f5, sunSprite: 0.35,
    rain: 0, wet: 0.15,
  },
  overcast: {
    label: '阴',
    sky: { zenith: '#4a5562', mid: '#6a7480', horizon: '#a4adb4', g1: '#7a8078', g2: '#444c46', g3: '#333a36', sunGlow: 0.06 },
    sunI: 0.6, sunColor: 0xcdd5e0, hemiI: 0.8, hemiSky: 0xaeb8c2, hemiGnd: 0x4c524c,
    fogColor: 0x9aa4ac, fogNear: 190, fogFar: 1250, exp: 0.84,
    cloudMul: 2.4, cloudTint: 0xc8ccd2, sunSprite: 0.06,
    rain: 0, wet: 0.35,
  },
  rain: {
    label: '雨',
    sky: { zenith: '#39424c', mid: '#55606a', horizon: '#828b93', g1: '#666c66', g2: '#3c423e', g3: '#2e3431', sunGlow: 0 },
    sunI: 0.35, sunColor: 0xb8c2cc, hemiI: 0.85, hemiSky: 0x9aa6b2, hemiGnd: 0x424a44,
    fogColor: 0x7f8890, fogNear: 130, fogFar: 850, exp: 0.76,
    cloudMul: 2.9, cloudTint: 0xaab0b8, sunSprite: 0,
    rain: 1, wet: 1,
  },
};

// 参数加权抽取（避免连续同款）
const WEIGHTS = [['sunny', 0.42], ['cloudy', 0.24], ['overcast', 0.19], ['rain', 0.15]];

function pickNext(cur) {
  let r = Math.random();
  let name = 'sunny';
  for (const [k, w] of WEIGHTS) {
    if (k === cur) continue; // 简化：抽中当前型重抽（权和无视 cur，概率近似即可）
    r -= w;
    if (r <= 0) { name = k; break; }
  }
  return name === cur ? 'cloudy' : name;
}

// 数值化参数（颜色转 THREE.Color，供逐帧混合）
function toParams(t) {
  return {
    zenith: C(t.sky.zenith), mid: C(t.sky.mid), horizon: C(t.sky.horizon),
    g1: C(t.sky.g1), g2: C(t.sky.g2), g3: C(t.sky.g3), sunGlow: t.sky.sunGlow,
    sunI: t.sunI, sunColor: C(t.sunColor), hemiI: t.hemiI,
    hemiSky: C(t.hemiSky), hemiGnd: C(t.hemiGnd),
    fogColor: C(t.fogColor), fogNear: t.fogNear, fogFar: t.fogFar,
    exp: t.exp, cloudMul: t.cloudMul, cloudTint: C(t.cloudTint),
    sunSprite: t.sunSprite, rain: t.rain, wet: t.wet,
  };
}

function blendParams(a, b, t) {
  const out = {};
  for (const k of Object.keys(a)) {
    const va = a[k], vb = b[k];
    if (va instanceof THREE.Color) out[k] = va.clone().lerp(vb, t);
    else out[k] = lerp(va, vb, t);
  }
  return out;
}

const hex = (c) => `#${c.getHexString()}`;

export function createWeather({
  scene, renderer, painter, pmrem, hemi, sun, sunSprite, clouds,
  fog, rain, audio, onNotice,
}) {
  let cur = 'sunny';
  let next = null;
  let mix = 1;
  let timer = 75 + Math.random() * 45;  // 首次变天前的晴朗时长
  let repaintCd = 0;
  let announced = true;

  // 混合起点定格在过渡开始时的 cur（不能把混合结果写回起点，否则指数漂移）
  let startP = toParams(WEATHER_TYPES.sunny);

  const weather = {
    wet: 0,                             // 路面湿滑 0..1（main.js 每帧转交给 player）
    get label() { return WEATHER_TYPES[cur].label; },

    // 内部状态（测试/调试用）
    debug() { return { cur, next, mix, timer, announced }; },

    // 强制切到某天气（测试/调试钩子）
    force(name) {
      if (!WEATHER_TYPES[name] || (name === cur && mix >= 1)) return false;
      next = name;
      startP = toParams(WEATHER_TYPES[cur]); // 定格当前天气为混合起点
      mix = 0;
      announced = false;
      return true;
    },

    update(dt, camPos) {
      // 触发下一次变天
      timer -= dt;
      if (mix >= 1 && timer <= 0) {
        next = pickNext(cur);
        startP = toParams(WEATHER_TYPES[cur]); // 定格当前天气为混合起点
        mix = 0;
        announced = false;
      }
      // 过渡推进（14s 缓动）
      if (mix < 1) {
        mix = Math.min(1, mix + dt / 14);
        if (mix >= 1 && !announced) {
          cur = next;
          timer = 80 + Math.random() * 70;
          announced = true;
          if (onNotice) onNotice(WEATHER_TYPES[cur].label);
        }
      }

      const targetP = toParams(WEATHER_TYPES[mix >= 1 ? cur : next]);
      const p = mix >= 1 ? targetP : blendParams(startP, targetP, smooth(mix));
      weather.wet = p.wet;

      // ---- 灯光 / 雾 / 曝光 / 云 / 太阳 sprite ----
      sun.intensity = p.sunI;
      sun.color.copy(p.sunColor);
      hemi.intensity = p.hemiI;
      hemi.color.copy(p.hemiSky);
      hemi.groundColor.copy(p.hemiGnd);
      fog.color.copy(p.fogColor);
      fog.near = p.fogNear;
      fog.far = p.fogFar;
      renderer.toneMappingExposure = p.exp;
      sunSprite.material.opacity = 0.85 * p.sunSprite;
      for (const c of clouds) {
        c.material.opacity = Math.min(1, c.userData.baseO * p.cloudMul);
        c.material.color.copy(p.cloudTint);
      }

      // ---- 天穹重绘 + 环境重烘（0.25s 节流，仅过渡期间发生）----
      repaintCd -= dt;
      if (mix < 1 && repaintCd <= 0) {
        repaintCd = 0.25;
        painter.repaint({
          zenith: hex(p.zenith), mid: hex(p.mid), horizon: hex(p.horizon),
          g1: hex(p.g1), g2: hex(p.g2), g3: hex(p.g3), sunGlow: p.sunGlow,
        });
        const old = scene.environment;
        scene.environment = pmrem.fromEquirectangular(painter.tex).texture;
        if (old) old.dispose();
      }

      // ---- 雨 ----
      rain.setIntensity(p.rain);
      rain.update(dt, camPos);
      if (audio) audio.setRain(p.rain);
    },
  };
  return weather;
}
