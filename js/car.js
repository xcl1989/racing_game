// car.js — 车辆：Ferrari GLB 真车模（Draco）+ 街机物理 + AI 跟车
// 加载失败时自动回退到程序化拼装车；玩家车按 spec 差异化物理
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HALF_WIDTH } from './track.js';
import { buildCarModel } from './cars.js';

// ---- GLB 模板加载（一次加载，多车克隆）----
let _loader = null;
function getLoader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('models/draco/'); // 本地解码器，避免 CDN WASM 加载卡死
    _loader.setDRACOLoader(draco);
  }
  return _loader;
}

// 归一化：车长 4.3m、最长轴对齐 Z、原点落在车底中心
// opts.flip=true 表示原模型车头朝 -Z（ferrari），需绕 Y 转 180°；车头朝 +Z 的模型（tesla）传 false
// opts.skipBounds：mesh 名单 —— 排除出包围盒计算（隐藏反壳会把边界撑大，导致缩放/居中失真）
export function loadCarTemplate(url = 'models/ferrari.glb', onProgress = null, opts = {}) {
  const flip = opts.flip !== false;      // 默认翻 180°（兼容 ferrari.glb）
  const skipBounds = new Set(opts.skipBounds || []);
  return new Promise((resolve, reject) => {
    getLoader().load(url, (gltf) => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      // 简化模型可能缺法线（减面管线丢弃 NORMAL）：重算平滑法线
      root.traverse((o) => {
        if (o.isMesh && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      });
      // 排除名单：临时隐藏再算包围盒
      const hidden = [];
      if (skipBounds.size) root.traverse((o) => {
        if (o.isMesh && skipBounds.has(o.name)) { o.visible = false; hidden.push(o); }
      });
      const box = new THREE.Box3().setFromObject(root);
      hidden.forEach((o) => { o.visible = true; });
      const size = box.getSize(new THREE.Vector3());
      const scale = 4.3 / Math.max(size.x, size.z);
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      if (size.x > size.z) root.rotation.y = Math.PI / 2; // 车长转到 Z 轴
      if (flip) root.rotation.y += Math.PI; // 模型车头朝 -Z，翻转到 +Z 与前进方向一致
      root.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(root);
      const center = box2.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      root.position.set(-center.x, -box2.min.y, -center.z);
      holder.add(root);
      resolve(holder);
    }, onProgress || undefined, reject);
  });
}

// 克隆模板并按名字换材质（车身漆/玻璃/轮毂）
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x18273a, metalness: 0.1, roughness: 0.05,
  transparent: true, opacity: 0.85, envMapIntensity: 2.4,
});
const rimMat = new THREE.MeshStandardMaterial({ color: 0xd6d9dd, metalness: 1.0, roughness: 0.22 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x22252a, metalness: 0.6, roughness: 0.45 });

export function createCarFromTemplate(template, colorHex) {
  const group = template.clone(true);
  const paint = new THREE.MeshPhysicalMaterial({
    color: colorHex, metalness: 0.75, roughness: 0.2,
    clearcoat: 1.0, clearcoatRoughness: 0.05, envMapIntensity: 1.6,
  });
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const n = (o.name || '').toLowerCase();
    const mn = (Array.isArray(o.material) ? o.material[0]?.name : o.material?.name || '').toLowerCase();
    // 车漆匹配：'blue' 是 ferrari 的第二块喷漆面板；'paint' 是 tesla 的 car_paint
    if (n.includes('body') || n === 'blue' || mn.includes('paint')) o.material = paint;
    // 玻璃匹配：ferrari 按网格名，tesla 按材质名 'windows'
    else if (n.includes('glass') || mn.includes('window') || mn.includes('glass')) o.material = glassMat;
    else if (n.includes('rim') || n.includes('trim')) o.material = rimMat;
  });
  // 轮子通用收集：ferrari 命名 wheel_*，tesla 命名 rim1_19/tyre1_23 等
  // 按"轮心位置"聚组并按 z 排序（车头 +Z）——排前面的即前轮，供 rotation.y 转向用
  const raw = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    const n = (o.name || '').toLowerCase();
    const mn = (Array.isArray(o.material) ? o.material[0]?.name : o.material?.name || '').toLowerCase();
    if (n.includes('wheel') || n.includes('rim') || n.includes('tyre'))
      raw.push(o);
  });
  // 按 z 从大到小排：同轮的 rim/tyre 网格位置几乎相同，自然相邻
  raw.sort((a, b) => b.getWorldPosition(_wp1).z - a.getWorldPosition(_wp2).z);
  const wheels = raw;
  addContactShadow(group);
  return { group, wheels, paint };
}

const _wp1 = new THREE.Vector3();
const _wp2 = new THREE.Vector3();

// 假接触阴影（接地感）：径向渐变软阴影，避免生硬矩形边缘
const _shadowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

function addContactShadow(group) {
  const ao = new THREE.Mesh(
    new THREE.PlaneGeometry(2.7, 5.2),
    new THREE.MeshBasicMaterial({ map: _shadowTex, transparent: true, depthWrite: false })
  );
  ao.rotation.x = -Math.PI / 2;
  ao.position.y = 0.045;
  ao.renderOrder = 1;
  group.add(ao);
}
// ---- 程序化兜底车（GLB 加载失败时用）：由 cars.js 轮廓车工厂提供 ----

// ---- 玩家车：街机物理（参数来自 spec：极速/加速/刹车/操控）----
export class PlayerCar {
  constructor(spec, template = null) {
    const built = template ? createCarFromTemplate(template, spec.color) : buildCarModel(spec);
    this.group = built.group;
    this.wheels = built.wheels;
    this.paint = built.paint;
    this.spec = spec;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;        // m/s，负值=倒车
    this.driftYaw = 0;     // 甩尾视觉偏航
    this.steerSm = 0;      // 平滑后的转向输入
    this.throttleSm = 0;   // 平滑后的油门
    this.hint = -1;        // 赛道最近样条提示
    this.trackT = 0;       // 归一化赛道进度 0..1
    this.total = 0;        // 总进度（圈数 + t），用于排名
    this.offroad = false;
  }

  // 换车：重建车模（保留位置朝向），更新物理 spec
  applySpec(spec, template = null) {
    const built = template ? createCarFromTemplate(template, spec.color) : buildCarModel(spec);
    const old = this.group;
    const parent = old.parent; // ⚠️ 先存父引用：remove(old) 会把 old.parent 置 null
    this.group = built.group;
    this.group.position.copy(old.position);
    this.group.rotation.copy(old.rotation);
    if (parent) {
      parent.remove(old);
      parent.add(this.group);
    }
    this.wheels = built.wheels;
    this.paint = built.paint;
    this.spec = spec;
  }

  reset(pos, yaw) {
    this.pos.copy(pos); this.yaw = yaw; this.speed = 0;
    this.driftYaw = 0; this.total = 0;
    this.syncMesh();
  }

  // ctrl: {throttle, brake, steer, handbrake}; groundY: 当前地面高度（桥面 1.2 / 平地 0）
  update(dt, ctrl, track, groundY = 0) {
    const off = track.isOffroad(this.pos, this.hint);
    this.hint = off.hint;
    this.offroad = off.off;
    // ★ 差异化物理：极速/加速/刹车/操控全部来自 spec，越野极速约 6 成
    const S = this.spec;
    const MAX = this.offroad ? S.topSpeed * 0.6 : S.topSpeed;

    // ★ 屏幕方向修正：相机从车尾看向 +Z 时水平轴镜像，
    //   yaw 增大会让车往屏幕"左"跑，所以转向取反才符合直觉。
    // ★ 输入平滑：转向/油门做指数插值，模拟真实转向机的渐进感
    this.steerSm += (-ctrl.steer - this.steerSm) * Math.min(1, dt * 6);
    this.throttleSm += (ctrl.throttle - this.throttleSm) * Math.min(1, dt * 6);
    const steer = this.steerSm;

    if (this.throttleSm > 0.02) this.speed += S.accel * this.throttleSm * dt * (this.offroad ? 0.65 : 1);
    if (ctrl.brake) this.speed -= S.brake * dt * (this.speed > 0 ? 1 : 0.5);
    this.speed -= this.speed * 0.4 * dt;                       // 空气/滚动阻力
    if (ctrl.handbrake) this.speed -= this.speed * 0.9 * dt;   // 手刹减速（仅键盘）
    if (this.offroad && Math.abs(this.speed) > MAX)
      this.speed -= Math.sign(this.speed) * 40 * dt;
    this.speed = Math.max(-8, Math.min(MAX + 6, this.speed));

    // 转向速率：偏真实——响应温和，高速明显收窄保证稳定；grip 决定车型操控差
    const spd = Math.abs(this.speed);
    const turnRate = 1.55 * S.grip * Math.min(1, spd / 12) * (1 - 0.5 * Math.min(1, spd / MAX));
    let turn = steer * turnRate * (this.speed < 0 ? -1 : 1);
    if (ctrl.handbrake) turn *= 1.5;
    this.yaw += turn * dt;
    this.driftYaw += ((ctrl.handbrake && spd > 14 ? steer * 0.35 : 0) - this.driftYaw)
      * Math.min(1, dt * 5);

    this.pos.x += Math.sin(this.yaw) * this.speed * dt;
    this.pos.z += Math.cos(this.yaw) * this.speed * dt;
    // 桥面/地面高度平滑过渡
    this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 8);
    // 世界边界
    const R = 1600;
    if (this.pos.length() > R) { this.pos.setLength(R); this.speed *= 0.5; }

    // ★ 护栏碰撞：仅比赛模式（护栏可见）且贴近路缘过渡带时生效
    this.wallHit = 0;
    {
      const railsOn = track.railGroup && track.railGroup.visible;
      const s = track.samples[this.hint];
      const onStrip = track.distToStrip(this.pos.x, this.pos.z) <= track.strip.width / 2 + 0.6;
      const lat = (this.pos.x - s.pos.x) * s.side.x + (this.pos.z - s.pos.z) * s.side.z;
      const LIMIT = HALF_WIDTH + 1.0;
      const inBand = Math.abs(lat) > LIMIT && Math.abs(lat) < LIMIT + 6;
      if (railsOn && !onStrip && inBand) {
        const push = (Math.abs(lat) - LIMIT) * Math.sign(lat);
        this.pos.addScaledVector(s.side, -push);
        // ★ 剐蹭强度按撞击角加权：垂直撞护栏重罚，平行蹭护栏只轻擦
        const tanA = Math.atan2(s.tan.x, s.tan.z);
        const hitAngle = Math.abs(Math.sin(this.yaw - tanA));
        this.wallHit = Math.min(1, (Math.abs(this.speed) / 30) * hitAngle);
        this.speed *= 1 - 0.25 * hitAngle; // 单帧最多 -25%（垂直时）
      }
    }

    // 赛道进度
    const { i } = track.nearestSample(this.pos, this.hint);
    const prevT = this.trackT;
    this.trackT = i / track.samples.length;
    if (this.trackT < 0.2 && prevT > 0.8) this.total += 1 - prevT + this.trackT; // 过起点
    else this.total += this.trackT - prevT;
    this.hint = i;

    // 车轮滚动 + 前轮转向
    const spin = this.speed * dt / 0.37;
    for (let k = 0; k < this.wheels.length; k++) {
      this.wheels[k].rotation.x -= spin;
      if (k < 2) this.wheels[k].rotation.y = steer * 0.4;
    }
    this.syncMesh();
    const braking = ctrl.brake && spd > 20;
    return {
      dust: this.offroad && spd > 4,
      drifting: ctrl.handbrake && spd > 12,
      skid: (ctrl.handbrake && spd > 12) || braking,
      wallHit: this.wallHit,
    };
  }

  syncMesh() {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw + this.driftYaw;
    this.group.rotation.z = -this.driftYaw * 0.6; // 甩尾侧倾
  }
}

// ---- AI 车：起步反应 + 加减速 + 弯道判弯 + 橡皮筋追赶 ----
// env = 任何有 {curve, length} 的路线（环道 / 高速 / 城市 / 乡道），dir=±1 双向行驶
export class AICar {
  constructor(color, lane, baseSpeed, template = null, route = null, dir = 1) {
    const built = template ? createCarFromTemplate(template, color) : buildCarModel({ id: 'ferrari', color });
    this.group = built.group;
    this.wheels = built.wheels;
    this.color = color;          // 供小地图着色
    this.lane = lane;
    this.baseSpeed = baseSpeed;
    this.speed = 0;              // 当前速度（m/s），真实加速/减速逼近目标
    this.reaction = 0.4 + Math.random() * 0.7; // 起步反应时间（车手差异）
    this.route = route;          // 巡航路线（NPC 车流用），比赛车为 null 走环道
    this.dir = dir;              // 行驶方向：1 正向，-1 逆向
    this.total = 0;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this._side = new THREE.Vector3();
    if (route) this.placeOn(route, 0);    // 出生即落到路面上
  }

  reset(track) {
    this.total = 0;
    this.speed = 0;
    this.reaction = 0.4 + Math.random() * 0.7;
    this.place(track);
  }

  // 比赛车（环道，含橡皮筋）
  update(dt, track, playerTotal) {
    if (this.reaction > 0) {
      this.reaction -= dt;
      this.place(track, 0);
      return;
    }
    const gap = playerTotal - this.total;
    const rubber = Math.max(-4, Math.min(6, gap * 20));

    const t = ((this.total / track.length) % 1 + 1) % 1;
    const tan1 = track.curve.getTangentAt(t);
    const tan2 = track.curve.getTangentAt((t + 0.012) % 1);
    const ang = tan1.angleTo(tan2);
    const corner = Math.max(0.45, 1 - ang * 14);
    const target = Math.max(8, (this.baseSpeed + rubber) * corner);

    const accel = 11, decel = 22;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);

    this.total += this.speed * dt;
    this.place(track, this.speed * dt / 0.37);
  }

  // NPC 车流（固定路线巡航；hold=true = 红灯停车）
  updateTraffic(dt, env, hold = false) {
    if (this.reaction > 0) {
      this.reaction -= dt;
      this.placeOn(env, 0);
      return;
    }
    const target = hold ? 0 : this.baseSpeed;
    const accel = 7, decel = 16;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);
    if (hold && this.speed < 0.05) { this.placeOn(env, 0); return; }
    this.total += this.speed * dt * this.dir;
    this.placeOn(env, Math.abs(this.speed) * dt / 0.37);
  }

  place(track, spin = 0) {
    const t = ((this.total / track.length) % 1 + 1) % 1;
    const p = track.curve.getPointAt(t);
    const tan = track.curve.getTangentAt(t).setY(0).normalize();
    this._side.set(tan.z, 0, -tan.x);
    this.pos.copy(p).addScaledVector(this._side, this.lane);
    this.pos.y = p.y;
    this.yaw = Math.atan2(tan.x, tan.z);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    for (const w of this.wheels) w.rotation.x -= spin;
  }

  placeOn(env, spin = 0) {
    const len = env.length;
    const t = ((this.total / len) % 1 + 1) % 1;
    const p = env.curve.getPointAt(t);
    const tan = env.curve.getTangentAt(t).setY(0).normalize();
    this._side.set(tan.z, 0, -tan.x).multiplyScalar(this.dir);
    this.pos.copy(p).addScaledVector(this._side, this.lane);
    this.pos.y = p.y;
    this.yaw = Math.atan2(tan.x * this.dir, tan.z * this.dir);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    for (const w of this.wheels) w.rotation.x -= spin;
  }
}
