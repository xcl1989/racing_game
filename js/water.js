// water.js — v2.24 水面材质升级：告别"纯平色块"
// 在 MeshStandardMaterial 上做 onBeforeCompile 注入，全部程序化、零外部资源：
//   1. 顶点波浪：三频正弦高度场位移（世界空间），解析法线随浪起伏
//   2. 菲涅尔：掠射角天空反射增强（配合天穹 PMREM 环境贴图）
//   3. 太阳高光：Blinn 高光条（太阳方向 uniform，随视角滑动的水面闪光）
//   4. 深度渐变：岸线浅水色 → 湖心深水色（按"距水线距离"场，圈形/条带两种模式）
//   5. 岸线泡沫：贴近水线处一层随浪抖动的白色泡沫带
// 消费方：world.js（河/湖2/公园水池）、scenery.js（湖1）。
// 每帧由 world.update() 调 updateWater(t) 推进波浪相位并滚动法线贴图。
import * as THREE from 'three';

const waterMats = []; // { mat, normalTex, scrollA:[sx,sy], scrollB:[sx,sy] }

// 太阳方向（与 main.js 太阳 sprite (700,900,-600) 同源，归一化后指向太阳）
const SUN_DIR = new THREE.Vector3(700, 900, -600).normalize();

const _v = /* glsl */ `
  uniform float uTime;
  uniform float uWaveAmp;
  uniform int uShoreMode;      // 0=圈形（湖，按世界坐标距湖心） 1=条带（河，按 |x-河心|）
  uniform vec2 uCenter;        // 水域中心（世界 xz）
  uniform float uShoreR;       // 水线半径/半宽（米）
  uniform float uBand;         // 浅水色带宽（米）
  uniform float uFoamBand;     // 泡沫带宽（米）
  varying vec3 vWorldPos;
  varying float vShore;        // 距水线距离（米，>=0 越深越大）
`;

// fragment 端专属 uniforms（光照/配色，顶点用不到）
const _f = /* glsl */ `
  uniform vec3 uSunDir;        // 指向太阳（已归一化）
  uniform vec3 uSunColor;
  uniform vec3 uShallow;       // 水线浅水色
  uniform vec3 uFoamC;         // 泡沫白
  uniform float uFoamK;        // 泡沫强度 0..1
  uniform float uGlint;        // 太阳高光强度
`;

// 三频正弦波 + 解析导数（GLSL）
const _waveFn = /* glsl */ `
  // 返回 (h, dh/dx, dh/dz)
  vec3 waveHD(vec2 p, float t) {
    float h = 0.0; vec2 g = vec2(0.0);
    // 波1：主浪（波长 ~70m）
    vec2 d1 = normalize(vec2(0.8, 0.6));
    float p1 = dot(p, d1) * 0.09 + t * 1.05;
    h += 1.00 * sin(p1); g += 1.00 * 0.09 * d1 * cos(p1);
    // 波2：交叉浪（波长 ~39m）
    vec2 d2 = normalize(vec2(-0.5, 0.85));
    float p2 = dot(p, d2) * 0.16 + t * 0.9 + 1.7;
    h += 0.55 * sin(p2); g += 0.55 * 0.16 * d2 * cos(p2);
    // 波3：碎浪（波长 ~23m）
    vec2 d3 = normalize(vec2(0.35, -0.94));
    float p3 = dot(p, d3) * 0.27 + t * 1.6 + 3.1;
    h += 0.28 * sin(p3); g += 0.28 * 0.27 * d3 * cos(p3);
    return vec3(h, g.x, g.y) * uWaveAmp;
  }
`;

export function makeWaterMaterial({
  deep = 0x0e466e, shallow = 0x2e7d9a, foam = 0.55, glint = 0.9,
  shoreMode = 'circle', center = [0, 0], shoreR = 100,
  band = 25, foamBand = 3, waveAmp = 0.055,
  normalTex = null, normalScale = 0.55, repeat = 20,
} = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: deep, metalness: 0.02, roughness: 0.3,
    transparent: true, opacity: 0.97,
    envMapIntensity: 0.6,
  });
  if (normalTex) {
    m.normalMap = normalTex;
    m.normalScale = new THREE.Vector2(normalScale, normalScale);
  }
  const u = m.userData.wu = {
    uTime: { value: 0 },
    uWaveAmp: { value: waveAmp },
    uShoreMode: { value: shoreMode === 'band' ? 1 : 0 },
    uCenter: { value: new THREE.Vector2(center[0], center[1]) },
    uShoreR: { value: shoreR },
    uBand: { value: band },
    uFoamBand: { value: foamBand },
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: new THREE.Color(0xfff0d0) },
    uShallow: { value: new THREE.Color(shallow) },
    uFoamC: { value: new THREE.Color(0xeef6f2) },
    uFoamK: { value: foam },
    uGlint: { value: glint },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    // ⚠️ '#include <common>' 只能 replace 一次（替换后 include 已不存在，第二次 replace 是无效空操作）
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + _v + '\n' + _waveFn)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        {
          vec4 wp4 = modelMatrix * vec4(position, 1.0);
          vec2 p = wp4.xz;
          // 距水线距离
          float dShore;
          if (uShoreMode == 0) dShore = uShoreR - distance(p, uCenter);
          else dShore = uShoreR - abs(p.x - uCenter.x);
          vShore = max(dShore, 0.0);
          // 波浪位移（局部 +z = 世界 +y：水体网格均 rotateX(-PI/2)）
          vec3 hd = waveHD(p, uTime);
          transformed.z += hd.x;
          vWorldPos = wp4.xyz + vec3(0.0, hd.x, 0.0);
        }
      `)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        #include <beginnormal_vertex>
        {
          vec4 wp4 = modelMatrix * vec4(position, 1.0);
          vec3 hd = waveHD(wp4.xz, uTime);
          vec3 nWorld = normalize(vec3(-hd.y, 1.0, -hd.z));
          objectNormal = normalize(nWorld * mat3(modelMatrix));
        }
      `);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + _v + '\n' + _f)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        {
          // 深度渐变：水线浅水色 → 湖心深水色
          float depthT = smoothstep(0.5, uBand, vShore);
          diffuseColor.rgb = mix(uShallow.rgb, diffuseColor.rgb, depthT);
          // 岸线泡沫：贴近水线 + 随浪抖动的碎边
          float jitter = sin(vWorldPos.x * 0.9 + vWorldPos.z * 1.3 - uTime * 2.1) * 0.5
            + sin(vWorldPos.x * 0.31 - vWorldPos.z * 0.47 + uTime * 1.4) * 0.5;
          float foamT = 1.0 - smoothstep(0.1, uFoamBand, vShore + jitter * uFoamBand * 0.35);
          foamT = clamp(foamT * uFoamK * (0.7 + 0.3 * jitter), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, uFoamC.rgb, foamT);
        }
      `)
      .replace('#include <lights_fragment_end>', /* glsl */ `
        #include <lights_fragment_end>
        {
          // 菲涅尔：掠射角环境反射增强（天穹 PMREM）——增益克制：地平线天空是
          // 白色雾霭，增益过猛整湖变"牛奶湖"（v2.24 实拍教训）
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          vec3 viewDirW = normalize(cameraPosition - vWorldPos);
          float fres = pow(1.0 - clamp(dot(viewDirW, wn), 0.0, 1.0), 5.0);
          reflectedLight.indirectSpecular *= (1.0 + fres * 1.3);
          // 太阳高光条
          vec3 refl = reflect(-viewDirW, wn);
          float glintT = pow(clamp(dot(refl, uSunDir), 0.0, 1.0), 160.0);
          reflectedLight.directSpecular += uSunColor * glintT * uGlint * (0.25 + fres);
        }
      `);
  };
  m.customProgramCacheKey = () => 'water-v1';
  waterMats.push({
    mat: m,
    normalTex,
    scrollA: [0.012, 0.02],
    scrollB: [-0.008, 0.014],
    baseRepeat: normalTex ? normalTex.repeat.clone() : null,
  });
  return m;
}

// 每帧推进：波浪相位 + 法线贴图双向滚动（第二层用 clone 贴图时注册第二个条目）
export function updateWater(t) {
  for (const w of waterMats) {
    if (w.mat.userData.wu) w.mat.userData.wu.uTime.value = t;
    if (w.normalTex) {
      w.normalTex.offset.set(t * w.scrollA[0], t * w.scrollA[1]);
    }
  }
}
