// fx.js — 特效：粒子尘土 / Bloom 后期 / 引擎音效
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
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

  add(x, z, yaw) {
    const d = this.dummy;
    d.position.set(x, 0.035 + (this.cursor % 7) * 0.001, z); // 微差避免 z-fight
    d.rotation.set(0, yaw, 0);
    d.scale.set(1, 1, 1);
    d.updateMatrix();
    this.mesh.setMatrixAt(this.cursor, d.matrix);
    this.cursor = (this.cursor + 1) % this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---- 后期合成器（Bloom 可开关，手机低配默认关）----
export function createComposer(renderer, scene, camera, enable) {
  const composer = new EffectComposer(renderer);
  // WebGL2 下 EffectComposer 默认 4x MSAA 渲染目标，开后期也不丢抗锯齿
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.55, 0.82
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.enabled = enable;
  return composer;
}

// ---- 引擎音效（WebAudio，需用户手势后 init）----
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
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 700;
    this.filter.connect(this.master);
    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 60;
    this.osc.connect(this.filter);
    this.osc.start();
  }

  setSpeed(speed, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 55 + Math.abs(speed) * 3.4;
    this.osc.frequency.setTargetAtTime(f, t, 0.06);
    this.filter.frequency.setTargetAtTime(500 + Math.abs(speed) * 20, t, 0.1);
    this.master.gain.setTargetAtTime(this.enabled && on ? 0.1 : 0, t, 0.12);
  }

  beep(freq = 880, dur = 0.15, vol = 0.2) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  }

  // 碰撞音：白噪声爆发，强度决定音量（内置 0.25s 冷却防连响）
  crash(intensity = 1) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    if (this._lastCrash && t - this._lastCrash < 0.25) return;
    this._lastCrash = t;
    const dur = 0.28;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 850;
    const g = this.ctx.createGain();
    g.gain.value = Math.min(0.45, 0.12 + intensity * 0.3);
    src.connect(f); f.connect(g); g.connect(this.ctx.destination);
    src.start(t);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled && this.ctx) this.setSpeed(0, false);
    return this.enabled;
  }
}
