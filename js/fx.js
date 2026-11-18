// fx.js — 特效：粒子尘土 / Bloom 后期 / 引擎音效
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'; // v2.21 桌面环境光遮蔽
import { makeGlowTexture } from './textures.js';

// ---- 尘土粒子池 ----
export class DustSystem {
  constructor(scene, count = 220) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    for (let i = 0; i < count; i++) this.positions[i * 3 + 1] = -999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      map: makeGlowTexture('rgba(230,215,180,0.85)', 'rgba(230,215,180,0)'),
      color: 0xd8ccb0, size: 1.6, transparent: true, opacity: 0.35,
      depthWrite: false, blending: THREE.NormalBlending, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.cursor = 0;
    scene.add(this.points);
  }

  emit(x, y, z, n = 1) {
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      this.positions[i * 3] = x + (Math.random() - 0.5) * 1.6;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z + (Math.random() - 0.5) * 1.6;
      this.life[i] = 1;
    }
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt * 1.4;
      this.positions[i * 3 + 1] += dt * 2.2;
      if (this.life[i] <= 0) this.positions[i * 3 + 1] = -999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---- 漂移白烟（Sprite 池：可生长、可淡出，比粒子尘土真实）----
export class SmokeSystem {
  constructor(scene, max = 46) {
    this.max = max;
    this.cursor = 0;
    this.pool = [];
    const tex = makeGlowTexture('rgba(242,240,238,0.95)', 'rgba(242,240,238,0)');
    for (let i = 0; i < max; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0xd8d4d0, transparent: true, opacity: 0, depthWrite: false,
        rotation: Math.random() * Math.PI,
      }));
      s.visible = false;
      scene.add(s);
      this.pool.push({ s, life: 0 });
    }
  }

  emit(x, y, z) {
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    p.life = 1;
    p.s.visible = true;
    p.s.position.set(x + (Math.random() - 0.5) * 0.8, y, z + (Math.random() - 0.5) * 0.8);
    p.s.scale.setScalar(0.9 + Math.random() * 0.5);
    p.s.material.opacity = 0.42;
    p.s.material.rotation = Math.random() * Math.PI;
  }

  update(dt) {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt * 0.85;
      p.s.position.y += dt * 1.5;
      p.s.scale.multiplyScalar(1 + dt * 1.7);
      p.s.material.opacity = Math.max(0, p.life * 0.42);
      if (p.life <= 0) p.s.visible = false;
    }
  }
}

// ---- 漂移胎痕（实例化黑色胎印池，循环复用）----
export class SkidMarks {
  constructor(scene, count = 300) {
    this.count = count;
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(0.3, 1.0);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x101010, transparent: true, opacity: 0.3, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dummy = new THREE.Object3D();
    // 初始化到远处隐藏
    this.dummy.position.set(0, -999, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    scene.add(this.mesh);
  }

  add(x, z, yaw, baseY = 0) {
    const d = this.dummy;
    d.position.set(x, baseY + 0.035 + (this.cursor % 7) * 0.001, z); // 微差避免 z-fight；baseY 供山地抬升
    d.rotation.set(0, yaw, 0);
    d.scale.set(1, 1, 1);
    d.updateMatrix();
    this.mesh.setMatrixAt(this.cursor, d.matrix);
    this.cursor = (this.cursor + 1) % this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- 雨系统（竖短线段池，盒状跟随相机 wrap 循环下落）----
export class RainSystem {
  constructor(scene, count = 900) {
    this.count = count;
    this.target = 0;          // 目标强度 0..1（weather 设置）
    this.v = 0;               // 当前强度（平滑逼近 target）
    this.area = 140;          // 雨幕盒边长（m）
    this.height = 46;         // 雨幕盒高
    const pos = new Float32Array(count * 6); // 每滴 2 顶点（上/下端）
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * this.area;
      const y = Math.random() * this.height;
      const z = (Math.random() - 0.5) * this.area;
      const len = 0.45 + Math.random() * 0.35;
      pos.set([x, y, z, x, y - len, z], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo = geo;
    this.mat = new THREE.LineBasicMaterial({
      color: 0xa8c0d4, transparent: true, opacity: 0, depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setIntensity(v) { this.target = v; }

  update(dt, cam) {
    // 强度平滑逼近（过渡期自然淡入淡出）
    this.v += (this.target - this.v) * Math.min(1, dt * 1.2);
    const op = this.v * 0.5;
    this.mat.opacity = op;
    this.mesh.visible = op > 0.008;
    if (!this.mesh.visible) return;
    const p = this.geo.attributes.position.array;
    const fall = (17 + this.v * 9) * dt;   // 雨越大落得越急
    const half = this.area / 2, H = this.height;
    for (let i = 0; i < this.count; i++) {
      const k = i * 6;
      const len = p[k + 1] - p[k + 4];
      // 下落
      p[k + 1] -= fall; p[k + 4] -= fall;
      // 底部出界：升回盒顶并随机换水平位置
      if (p[k + 4] < 0) {
        const ny = p[k + 1] + H;
        const x = cam.x + (Math.random() - 0.5) * this.area;
        const z = cam.z + (Math.random() - 0.5) * this.area;
        p[k] = x; p[k + 1] = ny; p[k + 2] = z;
        p[k + 3] = x; p[k + 4] = ny - len; p[k + 5] = z;
        continue;
      }
      // 水平 wrap（相机移动时雨幕始终跟随）
      const wrap = (v, c) => {
        let d = v - c;
        if (d > half) return v - this.area;
        if (d < -half) return v + this.area;
        return v;
      };
      p[k] = p[k + 3] = wrap(p[k], cam.x);
      p[k + 2] = p[k + 5] = wrap(p[k + 2], cam.z);
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

// ---- 后期合成器（Bloom 可开关，手机低配默认关）----
// v2.21：桌面可选 GTAO 环境光遮蔽（three r160 GTAOPass）—— 接触感/体积感的关键。
// 管线：RenderPass → GTAO(Default=拷贝美人图+混 AO) → Bloom → Output。
// GTAO 初始化失败（旧版 three/CDN 异常）自动降级为无 AO，不影响运行。
export function createComposer(renderer, scene, camera, enable, useGTAO = false, bloomStrength = 0.35) {
  const composer = new EffectComposer(renderer);
  // WebGL2 下 EffectComposer 默认 4x MSAA 渲染目标，开后期也不丢抗锯齿
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  let gtao = null;
  if (useGTAO) {
    try {
      gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
      // ⚠️ 必须用小半径+强距离衰减：默认参数在开放世界上会把广告牌/远处建筑
      //   的 AO 大片糊到路面上（实机 d3d11 验证，见 shots/v221_gtao_on.png 的教训）。
      //   调优后只保留车底接触阴影与近距立体感（shots/v221_gtao_tuned.png）。
      gtao.updateGtaoMaterial({
        radius: 0.12, distanceExponent: 2.2, thickness: 1.2,
        scale: 1.0, samples: 16, distanceFallOff: 2.0, screenSpaceRadius: false,
      });
      gtao.blendIntensity = 0.6;
      // v2.24 修复：GTAO 的 G-Buffer 渲染（renderOverride）会把透明 sprite（云/太阳辉光）
      //   当成实体表面画进法线/深度缓冲 → AO 混合后天空出现"硬边灰色矩形云"。
      //   解法：G-Buffer 渲染期间临时隐藏所有 sprite（美人图主渲染不受影响，实验：
      //   Diffuse 通道云完全正常，灰矩形只存在于 AO 混合路径）。
      const _origRenderOverride = gtao.renderOverride.bind(gtao);
      gtao.renderOverride = (renderer, mat, rt, clearColor, clearAlpha) => {
        const hidden = [];
        scene.traverse((o) => {
          if (o.isSprite && o.visible) { hidden.push(o); o.visible = false; }
        });
        _origRenderOverride(renderer, mat, rt, clearColor, clearAlpha);
        for (const o of hidden) o.visible = true;
      };
      composer.addPass(gtao);
    } catch (e) {
      console.warn('[fx] GTAO init failed, fallback without AO:', e);
      gtao = null;
    }
  }
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), bloomStrength, 0.55, 0.82
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.enabled = enable;
  composer.renderPass = renderPass; // 展厅热切 scene 用（main.js composer.passes[0] 同引用）
  composer.gtao = gtao;             // 展厅期间 enabled=false（GTAO 深度来自主场景，展厅无意义）
  composer.bloom = bloom;           // v2.22：特效档位/展厅调 strength 用
  return composer;
}

// ---- 引擎音效（v2.26 重制：多分量程序化引擎声，WebAudio，需用户手势后 init）----
// 旧版 = 单锯齿波 + 低通，只有车速一个变量 → 电锯/蚊子叫。
// 新版四层引擎：次低频正弦（怠速隆隆）+ 主锯齿（缸体音头）+ 微失谐锯齿（拍频厚度）
// + 二次谐波方波（点火脉冲），叠加进气/路噪（布朗噪声带通），油门与车速双变量调制；
// master 挂压缩器粘合防过载。
export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // master 链：压缩器（防多源叠加削波）→ 输出
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 6;
    this.comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.comp);

    // 引擎总线：低通（转速越高越亮）→ 总增益 → master
    this.engFilter = this.ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engFilter.Q.value = 0.7;
    this.engGain = this.ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter.connect(this.engGain);
    this.engGain.connect(this.master);

    // 四层振荡器（各自独立增益，音色配比可调）
    const mk = (type, gainV) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      const g = this.ctx.createGain();
      g.gain.value = gainV;
      o.connect(g); g.connect(this.engFilter);
      o.start();
      return { o, g };
    };
    this.sub = mk('sine', 0.55);     // 次低频：怠速隆隆的体感
    this.main = mk('sawtooth', 0.3); // 主音头
    this.det = mk('sawtooth', 0.26); // 微失谐：拍频让音色"厚"
    this.det.o.detune.value = 9;
    this.harm = mk('square', 0.1);   // 二次谐波：点火脉冲感

    // 进气/路噪：布朗噪声（积分白噪）循环 → 带通 → 噪声增益（随车速抬升）
    const dur = 2;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02; // 布朗积分：低频能量为主
      d[i] = last * 3.5;
    }
    this.noiseSrc = this.ctx.createBufferSource();
    this.noiseSrc.buffer = buf;
    this.noiseSrc.loop = true;
    this.nFilter = this.ctx.createBiquadFilter();
    this.nFilter.type = 'bandpass';
    this.nFilter.frequency.value = 220;
    this.nFilter.Q.value = 0.6;
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseSrc.connect(this.nFilter);
    this.nFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.master);
    this.noiseSrc.start();

    this._t0 = this.ctx.currentTime;
  }

  // speed: m/s；on: 引擎开关；throttle: 0..1 油门（连续值，car.js throttleSm）
  setSpeed(speed, on, throttle = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.abs(speed);
    // 转速映射：基础 46Hz + 车速项；怠速（<3m/s）加低频"喘振"微颤
    let f = 46 + s * 3.1;
    const idle = Math.max(0, 1 - s / 3);
    if (idle > 0) f += Math.sin((t - this._t0) * 17) * 2.2 * idle; // 怠速不平稳感
    const setF = (node, mult) => node.frequency.setTargetAtTime(f * mult, t, 0.07);
    setF(this.sub.o, 0.5);
    setF(this.main.o, 1);
    setF(this.det.o, 1.005);
    setF(this.harm.o, 2.02);
    // 低通随转速+油门开：低速闷、地板油透亮
    const bright = 320 + s * 26 + throttle * 900;
    this.engFilter.frequency.setTargetAtTime(bright, t, 0.09);
    // 进气/路噪：随车速渐入
    this.noiseGain.gain.setTargetAtTime(this.enabled && on ? Math.min(0.16, s * 0.004) : 0, t, 0.2);
    this.nFilter.frequency.setTargetAtTime(200 + s * 9, t, 0.15);
    // 总音量：怠速小声、油门给劲，比旧版略收敛防吵
    // ⚠️ master 是输出总闸（init 置 0 后必须随 enabled 打开）——v2.26.1 修复：
    //   旧逻辑只推 engGain，master 永远 0 → 引擎层整层静音（碰撞/beep 直连 destination 不受影响）
    const vol = this.enabled && on
      ? 0.045 + 0.075 * Math.min(1, throttle * 0.75 + s / 55)
      : 0;
    this.engGain.gain.setTargetAtTime(vol, t, 0.1);
    this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, t, 0.1);
  }

  beep(freq = 880, dur = 0.15, vol = 0.2) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle'; // v2.26 方波→三角波：去硬边毛刺
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    // 软起音（8ms attack）消"咔哒"爆音，指数衰减收尾
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // 碰撞音（v2.26 重制）：低频 thump（金属撞击体感）+ 带通冲击噪声（碎裂感）
  // + 高频散落（仅重撞）。旧版纯白噪爆 = 电视雪花声。
  crash(intensity = 1) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    if (this._lastCrash && t - this._lastCrash < 0.25) return;
    this._lastCrash = t;
    const i = Math.max(0.2, Math.min(1.6, intensity));
    // 1) thump：三角波 110→38Hz 滑落，瞬间起音快速衰减
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(110 + i * 30, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const g1 = this.ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.linearRampToValueAtTime(Math.min(0.5, 0.28 * i), t + 0.004);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    o.connect(g1); g1.connect(this.ctx.destination);
    o.start(t); o.stop(t + 0.2);
    // 2) 冲击噪声：带通 900Hz 短爆发（三次幂衰减更"脆"）
    const dur2 = 0.13;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur2, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) {
      d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / d.length, 3);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 700 + i * 350;
    f2.Q.value = 0.9;
    const g2 = this.ctx.createGain();
    g2.gain.value = Math.min(0.32, 0.1 + i * 0.16);
    src.connect(f2); f2.connect(g2); g2.connect(this.ctx.destination);
    src.start(t);
    // 3) 碎屑散落：重撞（>0.6）时加 60ms 高频颗粒
    if (i > 0.6) {
      const dur3 = 0.06;
      const buf3 = this.ctx.createBuffer(1, this.ctx.sampleRate * dur3, this.ctx.sampleRate);
      const d3 = buf3.getChannelData(0);
      for (let j = 0; j < d3.length; j++) {
        d3[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / d3.length, 2);
      }
      const src3 = this.ctx.createBufferSource();
      src3.buffer = buf3;
      const f3 = this.ctx.createBiquadFilter();
      f3.type = 'highpass';
      f3.frequency.value = 2600;
      const g3 = this.ctx.createGain();
      g3.gain.value = 0.07 * i;
      src3.connect(f3); f3.connect(g3); g3.connect(this.ctx.destination);
      src3.start(t);
    }
  }

  // 雨声（v2.26 调音）：带通略降 + 串联低通去"沙沙"毛刺，双层体积感
  setRain(vol = 0) {
    if (!this.ctx) return;
    if (!this.rainGain) {
      const dur = 2;
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 850;
      f.Q.value = 0.4;
      const lp = this.ctx.createBiquadFilter(); // 去高频毛刺：雨声偏"绵"不"炸"
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(f); f.connect(lp); lp.connect(this.rainGain); this.rainGain.connect(this.ctx.destination);
      src.start();
    }
    const t = this.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(this.enabled ? vol * 0.13 : 0, t, 0.5);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled && this.ctx) {
      this.setSpeed(0, false);
      this.setRain(0);
    }
    return this.enabled;
  }
}
