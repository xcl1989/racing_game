// game.js — 游戏逻辑：模式管理 / 检查点与圈数 / 收集挑战 / HUD / 小地图
import * as THREE from 'three';
import { gyroState } from './input.js';

const LAPS_RACE = 3;
const $ = (id) => document.getElementById(id);
const fmtTime = (s) => {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
};

export class Game {
  constructor({ track, player, ais, dust, skids, smoke, audio, world, traffic }) {
    this.track = track; this.player = player; this.ais = ais;
    this.dust = dust; this.skids = skids; this.smoke = smoke; this.audio = audio;
    this.world = world; this.traffic = traffic;
    // 漫游时世界路网（高速/乡道/城市街道）不算越野
    this.track.worldOnRoad = (pos) => this.world.onAnyRoad(pos);
    this.mode = 'free';
    this.state = 'menu';           // menu | countdown | running | paused | finished
    this.lap = 1; this.nextGate = 1;
    this.elapsed = 0; this.countdown = 0;
    this.lastT = 0;
    this.crashShake = 0; // 碰撞震屏强度（随时间衰减）
    this.dismissedFor = null; // 「稍后再说」忽略的活动（驶出范围后重置）

    // 小地图缩放档位：点击循环切换（s = 像素/米）
    this.mmZooms = [
      { label: '全景', s: 0.042 },  // 约容纳 3.5km 视野（整个大世界）
      { label: '1km', s: 0.15 },
      { label: '500m', s: 0.3 },
      { label: '200m', s: 0.75 },
    ];
    this.mmZoomIdx = 3; // 默认 200m：接近原 GPS 视角

    this.buildRings();
    this.buildEvents();
    this.buildMinimapBase();
    this.bindUI();
    // 点击小地图循环切换范围
    document.getElementById('minimap').addEventListener('pointerdown', () => {
      this.mmZoomIdx = (this.mmZoomIdx + 1) % this.mmZooms.length;
      this.audio.beep(660, 0.08, 0.1);
    });
  }

  // ---- 地图活动（Forza 式光柱：开进去即可报名）----
  buildEvents() {
    const scene = this.track.gatesGroup.parent;
    const OFF = 12; // 活动牌距路缘的横向距离（路外，不挡道）
    const mkPos = (t, lateral) => {
      const p = this.track.curve.getPointAt(t);
      const tan = this.track.curve.getTangentAt(t).setY(0).normalize();
      const side = new THREE.Vector3(tan.z, 0, -tan.x);
      return p.clone().addScaledVector(side, lateral).setY(0);
    };
    const S = this.track.strip;
    this.events = [
      {
        mode: 'race', name: '🏁 公路环道赛', desc: '3 圈 · 对抗 3 名 AI',
        color: 0xffaa22, radius: 14, pos: mkPos(0.008, OFF),
      },
      {
        mode: 'time', name: '⏱ 单圈计时赛', desc: '单圈冲刺 · 冲击最速纪录',
        color: 0x44ddff, radius: 14, pos: mkPos(0.5, OFF),
      },
      {
        mode: 'collect', name: '💠 能量环收集', desc: '收集 14 个能量环',
        color: 0x22dd88, radius: 14, pos: mkPos(0.75, OFF),
      },
      {
        mode: 'drag', name: '🚀 直线加速赛', desc: '760m 直线冲刺 · 计时 + 尾速',
        color: 0xff4455, radius: 16, pos: new THREE.Vector3(S.ax + 12, 0, S.az + 20),
      },
    ];
    // 光柱 + 底座光环 + 悬浮名牌
    this.eventRings = [];
    this.eventGroup = new THREE.Group();
    const beamMatOf = (c) => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const ev of this.events) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.1, 1.6, 50, 12, 1, true),
        beamMatOf(ev.color)
      );
      beam.position.copy(ev.pos).setY(25);
      this.eventGroup.add(beam);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.18, 8, 26),
        new THREE.MeshStandardMaterial({
          color: ev.color, emissive: ev.color, emissiveIntensity: 2.0, metalness: 0.4, roughness: 0.3,
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(ev.pos).setY(0.6);
      this.eventGroup.add(ring);
      this.eventRings.push(ring);
      // 名牌
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 72;
      const cx2 = cv.getContext('2d');
      cx2.fillStyle = 'rgba(8,16,30,0.78)';
      cx2.fillRect(0, 0, 256, 72);
      cx2.strokeStyle = `#${ev.color.toString(16).padStart(6, '0')}`;
      cx2.lineWidth = 3;
      cx2.strokeRect(1.5, 1.5, 253, 69);
      cx2.font = '600 30px "Segoe UI", "PingFang SC", sans-serif';
      cx2.fillStyle = '#ffffff';
      cx2.textAlign = 'center';
      cx2.textBaseline = 'middle';
      cx2.fillText(ev.name, 128, 38);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      label.scale.set(18, 5, 1);
      label.position.copy(ev.pos).setY(7.5);
      this.eventGroup.add(label);
    }
    this.eventGroup.visible = false; // 仅自由漫游时可见
    scene.add(this.eventGroup);
    this.promptEvent = null;
  }

  // ---- 收集挑战：发光圆环 ----
  buildRings() {
    this.rings = [];
    this.ringGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x22ddff, emissive: 0x22ddff, emissiveIntensity: 2.4, metalness: 0.5, roughness: 0.2,
    });
    const geo = new THREE.TorusGeometry(3.4, 0.32, 10, 28);
    const N = 14;
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      const p = this.track.curve.getPointAt(t);
      const tan = this.track.curve.getTangentAt(t).setY(0).normalize();
      const side = new THREE.Vector3(tan.z, 0, -tan.x);
      const ring = new THREE.Mesh(geo, mat);
      ring.position.copy(p).addScaledVector(side, (Math.random() * 2 - 1) * 4).setY(2.2);
      ring.lookAt(ring.position.clone().add(tan));
      this.ringGroup.add(ring);
      this.rings.push(ring);
    }
    this.ringGroup.visible = false;
    this.track.gatesGroup.parent.add(this.ringGroup); // 挂到 scene
  }

  // ---- 小地图底图（全路网：环道+高速+城市+乡道）----
  buildMinimapBase() {
    const S = 150;
    this.mapBase = document.createElement('canvas');
    this.mapBase.width = S; this.mapBase.height = S;
    const x = this.mapBase.getContext('2d');
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const grow = (wx, wz) => {
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    };
    for (const s of this.track.samples) grow(s.pos.x, s.pos.z);
    for (const poly of this.world.minimapPolylines) {
      for (const [wx, wz] of poly) grow(wx, wz);
    }
    const pad = 10;
    const sc = Math.min((S - pad * 2) / (maxX - minX), (S - pad * 2) / (maxZ - minZ));
    this.mapFn = (wx, wz) => [pad + (wx - minX) * sc, S - pad - (wz - minZ) * sc];
    const drawPoly = (poly, style, width) => {
      x.strokeStyle = style;
      x.lineWidth = width;
      x.beginPath();
      poly.forEach(([wx, wz], i) => {
        const [mx, my] = this.mapFn(wx, wz);
        i === 0 ? x.moveTo(mx, my) : x.lineTo(mx, my);
      });
      x.closePath();
      x.stroke();
    };
    const [hwPoly, cityPoly, ctryPoly] = this.world.minimapPolylines;
    drawPoly(hwPoly, 'rgba(88,108,130,0.95)', 5);  // 高速
    drawPoly(cityPoly, '#7fa8d9', 3);               // 城市
    drawPoly(ctryPoly, '#c9b98a', 3);               // 乡道
    for (let i = 3; i < this.world.minimapPolylines.length; i++) {
      drawPoly(this.world.minimapPolylines[i], '#7fa8d9', 2); // 街道网格
    }
    x.strokeStyle = 'rgba(255,255,255,0.95)';
    x.lineWidth = 4;
    x.beginPath();
    this.track.samples.forEach((s, i) => {
      const [mx, my] = this.mapFn(s.pos.x, s.pos.z);
      i === 0 ? x.moveTo(mx, my) : x.lineTo(mx, my);
    });
    x.closePath();
    x.stroke();
    // 起点标记
    const [sx, sy] = this.mapFn(this.track.startPos.x, this.track.startPos.z);
    x.fillStyle = '#ffdd44';
    x.beginPath(); x.arc(sx, sy, 4, 0, Math.PI * 2); x.fill();
  }

  // ---- GPS 式旋转小地图：车居中箭头朝上，地图跟随旋转；点击切档 ----
  drawMinimap() {
    const c = $('minimap');
    const x = c.getContext('2d');
    const S = c.width;
    x.clearRect(0, 0, S, S);
    const zoom = this.mmZooms[this.mmZoomIdx];
    const s = zoom.s; // 缩放：像素/米
    const yaw = this.player.yaw;
    const px = this.player.pos.x, pz = this.player.pos.z;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    // 世界坐标 → 屏幕坐标（车头朝上）
    const toScreen = (wx, wz) => [
      S / 2 + (-(wx - px) * cosY + (wz - pz) * sinY) * s,
      S / 2 + (-(wx - px) * sinY - (wz - pz) * cosY) * s,
    ];
    const onMap = ([mx, my]) => mx > -6 && mx < S + 6 && my > -6 && my < S + 6;

    // 线宽补偿：缩得越远线越细，用平方根压缩保持可见但不虚胖
    const lwBoost = Math.sqrt(1.1 / s);

    // 道路层：地图随车旋转
    x.save();
    x.translate(S / 2, S / 2);
    x.scale(s, s);
    x.rotate(Math.PI + yaw);
    x.translate(-px, -pz);
    const poly = (pts, style, w) => {
      x.strokeStyle = style;
      x.lineWidth = w * lwBoost;
      x.beginPath();
      pts.forEach(([wx, wz], i) => i === 0 ? x.moveTo(wx, wz) : x.lineTo(wx, wz));
      x.closePath();
      x.stroke();
    };
    const [hwPoly, cityPoly, ctryPoly] = this.world.minimapPolylines;
    poly(hwPoly, 'rgba(88,108,130,0.95)', 20);   // 高速
    poly(cityPoly, '#7fa8d9', 12);                // 城市
    poly(ctryPoly, '#c9b98a', 8);                 // 乡道
    for (let i = 3; i < this.world.minimapPolylines.length; i++) {
      poly(this.world.minimapPolylines[i], '#7fa8d9', 10); // 街道网格
    }
    const ST = this.track.strip;
    poly([[ST.ax, ST.az], [ST.bx, ST.bz]], 'rgba(120,200,255,0.9)', 10); // 直线赛道
    x.strokeStyle = 'rgba(255,255,255,0.95)';
    x.lineWidth = 8 * lwBoost;
    x.beginPath();
    this.track.samples.forEach((sm, i) => i === 0 ? x.moveTo(sm.pos.x, sm.pos.z) : x.lineTo(sm.pos.x, sm.pos.z));
    x.closePath();
    x.stroke();
    x.restore();

    // 圆点层（屏幕空间，超出裁掉）
    const dot = (wx, wz, color, r) => {
      const m = toScreen(wx, wz);
      if (!onMap(m)) return;
      x.fillStyle = color;
      x.beginPath(); x.arc(m[0], m[1], r, 0, Math.PI * 2); x.fill();
      x.lineWidth = 1;
      x.strokeStyle = 'rgba(0,0,0,0.55)';
      x.stroke();
    };
    if (this.mode !== 'drag') {
      for (const ev of this.events) dot(ev.pos.x, ev.pos.z, `#${ev.color.toString(16).padStart(6, '0')}`, 4);
    }
    for (const ai of this.ais) {
      if (ai.group.visible) dot(ai.pos.x, ai.pos.z, `#${ai.color.toString(16).padStart(6, '0')}`, 3.5);
    }
    for (const t of this.traffic) {
      if (t.group.visible) dot(t.pos.x, t.pos.z, 'rgba(235,235,235,0.95)', 2.5);
    }
    if (this.ringGroup.visible) {
      for (const r of this.rings) {
        if (r.userData.done) continue;
        dot(r.position.x, r.position.z, '#22ddff', 2.5);
      }
    }

    // 北向指示（随旋转移动）
    const nx = S / 2 + sinY * (S / 2 - 12), ny = S / 2 + cosY * (S / 2 - 12);
    x.fillStyle = '#ffffff';
    x.font = 'bold 11px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('N', nx, ny);

    // 当前档位标签（左下角）
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.font = '10px sans-serif';
    x.textAlign = 'left';
    x.fillText(zoom.label, 6, S - 8);

    // 玩家箭头（居中，指向正上）
    x.fillStyle = '#ff3344';
    x.strokeStyle = '#ffffff';
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(S / 2, S / 2 - 8);
    x.lineTo(S / 2 + 5.5, S / 2 + 6);
    x.lineTo(S / 2, S / 2 + 3);
    x.lineTo(S / 2 - 5.5, S / 2 + 6);
    x.closePath();
    x.fill();
    x.stroke();
  }

  // ---- 模式启动 ----
  startMode(mode) {
    this.mode = mode;
    // 自由漫游免倒计时直接开跑；其余模式 3.2s 倒计时
    this.state = mode === 'free' ? 'running' : 'countdown';
    this.countdown = 3.2;
    this.elapsed = 0;
    this.lap = 1;
    this.nextGate = 1;
    this.collected = 0;
    this.lastT = 0;
    this.topSpeed = 0;
    this.audio.init();

    // 🚀 直线加速赛：起跑到终点线沿直线赛道，不占环道发车格
    if (mode === 'drag') {
      const S = this.track.strip;
      const startYaw = Math.atan2(S.bx - S.ax, S.bz - S.az);
      const side = new THREE.Vector3((S.bz - S.az), 0, -(S.bx - S.ax)).normalize();
      const p0 = new THREE.Vector3(S.ax, 0, S.az)
        .addScaledVector(side, -3.5)
        .add(new THREE.Vector3(0, 0, 14));
      this.player.reset(p0, startYaw);
      this.dragEnd = new THREE.Vector3(S.bx, 0, S.bz);
      this.eventGroup.visible = false;
    } else {
      // ★ 发车格：P1 最前，前后错列 8m + 左右交错 ±3m；AI 占 P1-P3，玩家 P4
      const gridSlot = (k) => {
        const d = 6 + k * 8;                                 // 距起点线的前向距离
        const t = Math.min(0.09, d / this.track.length);     // 保持在前第一个检查点之内
        const p = this.track.curve.getPointAt(t);
        const tan = this.track.curve.getTangentAt(t).setY(0).normalize();
        const side = new THREE.Vector3(tan.z, 0, -tan.x);
        const pos = p.clone().addScaledVector(side, k % 2 === 0 ? 3 : -3);
        const yaw = Math.atan2(tan.x, tan.z);
        return { pos, yaw, d, t };
      };

      // 竞速赛玩家 P4 追赶；计时赛单人占 P1 头排；自由漫游从起点出发
      const pSlot = gridSlot(mode === 'race' ? 3 : 0);
      this.player.reset(pSlot.pos, pSlot.yaw);
      this.player.trackT = pSlot.t;
      this.lastT = pSlot.t;
      this.ais.forEach((ai, i) => {
        ai.reset(this.track);
        const s = gridSlot(i);
        ai.total = s.d;
        ai.place(this.track);
      });
    }

    const raceLike = mode === 'race' || mode === 'time';
    const showAI = mode === 'race' || mode === 'free';
    this.track.gatesGroup.visible = raceLike;
    this.ringGroup.visible = mode === 'collect';
    this.eventGroup.visible = mode === 'free'; // 光柱只在漫游时可见
    // ★ 护栏仅比赛时出现（漫游自由越野，直线赛道开阔）
    if (this.track.railGroup) this.track.railGroup.visible = raceLike;
    this.ais.forEach((a) => { a.group.visible = showAI; });
    // NPC 车流只在漫游/收集时出现（比赛让路，直线赛道空旷）
    this.traffic.forEach((t) => { t.group.visible = mode === 'free' || mode === 'collect'; });
    for (const r of this.rings) r.userData.done = false;

    $('menu').style.display = 'none';
    $('result').style.display = 'none';
    $('hud').style.display = 'block';
    $('controls').style.display = 'flex';
    // 收集挑战显示已收集数；直线加速赛复用该栏显示剩余距离
    const infoBox = mode === 'collect' ? 'collect' : (mode === 'drag' ? 'drag' : null);
    $('collect-box').style.display = infoBox ? 'block' : 'none';
    $('collect-val').textContent = infoBox === 'drag' ? '760 m' : '0 / 14';
    $('lap-box').style.display = raceLike ? 'block' : 'none';
    $('rank-box').style.display = mode === 'race' ? 'block' : 'none';
    const modeName = {
      race: '🏁 竞速赛 3圈', time: '⏱ 计时赛 1圈', collect: '💠 收集挑战',
      drag: '🚀 直线加速赛', free: '🌊 自由漫游',
    };
    $('mode-val').textContent = modeName[mode];
    const best = localStorage.getItem(`rg_best_${mode}`);
    $('best-line').style.display = best ? 'block' : 'none';
    if (best) $('best-val').textContent = fmtTime(parseFloat(best));
    if (mode === 'free') {
      this.toast('开到地图上的彩色光柱即可报名比赛', 3500);
    } else {
      this.toast('准备…', 1200);
      // 手机转向只靠陀螺仪：没开就提醒（iOS 需手动授权）
      if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) && !gyroState.enabled) {
        this.toast('⚠ 未开启陀螺仪，无法转向！回主菜单点「陀螺仪: 开」', 3500);
      }
    }
  }

  toMenu() {
    this.state = 'menu';
    $('menu').style.display = 'flex';
    $('result').style.display = 'none';
    $('hud').style.display = 'none';
    $('controls').style.display = 'none';
    this.track.gatesGroup.visible = false;
    if (this.track.railGroup) this.track.railGroup.visible = false;
    this.traffic.forEach((t) => { t.group.visible = false; });
    this.ringGroup.visible = false;
    this.player.reset(this.track.startPos, this.track.startYaw);
    for (const ai of this.ais) { ai.group.visible = false; }
  }

  togglePause() {
    if (this.state === 'running' || this.state === 'countdown') {
      this.state = 'paused';
      this.toast('⏸ 已暂停（点按钮继续）', 999999);
    } else if (this.state === 'paused') {
      this.state = 'running';
      $('toast').style.display = 'none';
    }
  }

  toast(msg, dur = 1500) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(this._tt);
    if (dur < 99999) this._tt = setTimeout(() => { t.style.display = 'none'; }, dur);
  }

  // ---- 活动报名 / 返回漫游 ----
  setPromptEvent(ev) {
    if (ev === this.promptEvent) return;
    this.promptEvent = ev;
    if (ev) {
      $('ep-name').textContent = ev.name;
      $('ep-desc').textContent = ev.desc;
      $('event-prompt').style.display = 'flex';
      this.audio.beep(520, 0.12, 0.15);
    } else {
      $('event-prompt').style.display = 'none';
    }
  }

  // 「稍后再说」：本光柱标记为已忽略，驶出范围前不再弹出
  dismissPrompt() {
    if (this.promptEvent) this.dismissedFor = this.promptEvent;
    this.setPromptEvent(null);
  }

  acceptEvent() {
    if (!this.promptEvent) return;
    const ev = this.promptEvent;
    this.returnPos = this.player.pos.clone(); // 完赛后送回报名点
    this.setPromptEvent(null);
    this.startMode(ev.mode);
    this.toast(`已报名：${ev.name}`, 2000);
  }

  returnToFree() {
    const p = this.returnPos || this.track.startPos;
    const yaw = this.player.yaw;
    this.startMode('free');
    this.player.reset(p.clone().setY(0), yaw);
  }

  // ---- 检查点穿越判定（处理环形回绕）----
  crossed(prev, cur, g) {
    return prev <= cur ? (g > prev && g <= cur) : (g > prev || g <= cur);
  }

  finish() {
    this.state = 'finished';
    this.audio.setSpeed(0, false);
    let title = '🏁 完成！', line = '';
    if (this.mode === 'race') {
      const rank = 1 + this.ais.filter((a) => a.total > this.player.total).length;
      title = rank === 1 ? '🏆 冠军！' : `第 ${rank} 名`;
      line = `用时 ${fmtTime(this.elapsed)}`;
    } else if (this.mode === 'drag') {
      title = '🚀 冲线！';
      line = `用时 ${fmtTime(this.elapsed)} · 尾速 ${Math.round(this.topSpeed * 3.6)} km/h`;
      const key = 'rg_best_drag';
      const best = parseFloat(localStorage.getItem(key) || '0');
      if (!best || this.elapsed < best) {
        localStorage.setItem(key, this.elapsed.toFixed(1));
        line += `（新纪录！）`;
      }
    } else {
      const key = `rg_best_${this.mode}`;
      const best = parseFloat(localStorage.getItem(key) || '0');
      if (!best || this.elapsed < best) {
        localStorage.setItem(key, this.elapsed.toFixed(1));
        line = `新纪录 ${fmtTime(this.elapsed)}！（原纪录 ${best ? fmtTime(best) : '无'}）`;
      } else {
        line = `用时 ${fmtTime(this.elapsed)}（纪录 ${fmtTime(best)}）`;
      }
    }
    $('res-title').textContent = title;
    $('res-line').textContent = line;
    $('result').style.display = 'flex';
    this.audio.beep(660, 0.3);
    setTimeout(() => this.audio.beep(990, 0.4), 200);
  }

  // ---- 主更新：返回相机抖动强度 ----
  update(dt, input) {
    if (this.state === 'menu' || this.state === 'paused' || this.state === 'finished') {
      this.audio.setSpeed(0, false);
      return 0;
    }

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this._lastCnt && n > 0) { this.audio.beep(440, 0.2); this.toast(`${n}`, 900); }
      if (this.countdown <= 0) {
        this.state = 'running';
        this.audio.beep(880, 0.35, 0.3);
        this.toast('GO!', 800);
      }
      this._lastCnt = n;
      this.player.syncMesh();
      return 0;
    }

    this.elapsed += dt;

    // 玩家物理（含桥面高度平滑过渡）
    const groundY = this.world ? this.world.heightAt(this.player.pos) : 0;
    const res = this.player.update(dt, input, this.track, groundY);
    if (res.dust || res.drifting) {
      const back = this.player.pos.clone();
      back.x -= Math.sin(this.player.yaw) * 1.6;
      back.z -= Math.cos(this.player.yaw) * 1.6;
      this.dust.emit(back.x, 0.3, back.z, res.drifting ? 3 : 1);
    }
    // 漂移/重刹：后轮落胎痕 + 冒白烟
    if (res.skid) {
      const p = this.player;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      for (const lx of [-0.92, 0.92]) {
        const wx = p.pos.x + lx * cy - 1.35 * sy;
        const wz = p.pos.z - lx * sy - 1.35 * cy;
        this.skids.add(wx, wz, p.yaw);
        if (res.drifting) this.smoke.emit(wx, 0.4, wz);
      }
    }
    // 护栏剐蹭：震屏 + 碰撞音
    if (res.wallHit > 0.05) {
      this.crashShake = Math.max(this.crashShake, res.wallHit * 0.5);
      this.audio.crash(res.wallHit);
    }

    // ★ 车对车碰撞：双向推开 + 动量交换 + 横摆扰动 + 碰撞音 + 震屏
    for (const ai of this.ais) {
      if (!ai.group.visible) continue;
      ai.update(dt, this.track, this.player.total);
      const d = ai.pos.distanceTo(this.player.pos);
      if (d < 2.9 && d > 0.01) {
        const n = this.player.pos.clone().sub(ai.pos).normalize();
        const overlap = 2.9 - d;
        // 玩家承担 70% 位移（保持可控），AI 被顶开 30%
        this.player.pos.addScaledVector(n, overlap * 0.7);
        ai.pos.addScaledVector(n, -overlap * 0.3);
        // 动量交换：相对速度越大，玩家掉速越多
        const relSpeed = Math.abs(this.player.speed - (ai.speed || 0));
        this.player.speed *= 1 - Math.min(0.5, relSpeed * 0.014);
        // 横摆扰动：被撞得转一下方向
        this.player.driftYaw += (Math.random() - 0.5) * 0.2;
        ai.total = Math.max(ai.total - 0.6, 0); // AI 被撞退
        this.crashShake = 0.65;
        this.audio.crash(relSpeed / 30);
      }
    }
    // 撞击震屏衰减
    this.crashShake = Math.max(0, this.crashShake - dt * 1.6);

    // NPC 车流：红绿灯停车 + 巡航（红绿灯周期由 world.update 驱动）
    this.world.update(dt);
    for (const t of this.traffic) {
      if (!t.group.visible) continue;
      let hold = false;
      if (this.world.isRed()) {
        for (const L of this.world.lights) {
          const d = t.pos.distanceTo(L.pos);
          if (d < 18 && d > 3) { hold = true; break; }
        }
      }
      t.updateTraffic(dt, t.route, hold);
    }

    // 检查点 / 圈数
    if (this.mode === 'race' || this.mode === 'time') {
      const GT = this.track.GT || (this.track.GT = Array.from({ length: 10 }, (_, k) => k / 10));
      const prevT = this.lastT, curT = this.player.trackT;
      if (this.crossed(prevT, curT, GT[this.nextGate])) {
        if (this.nextGate === 9) this.nextGate = 0;
        else if (this.nextGate === 0) {
          this.nextGate = 1;
          this.lap++;
          const target = this.mode === 'race' ? LAPS_RACE : 1;
          if (this.lap > target) { this.finish(); return 0; }
          this.toast(`第 ${this.lap} 圈！`, 1200);
        } else this.nextGate++;
      }
      this.lastT = curT;
    }

    // 收集挑战
    if (this.mode === 'collect') {
      for (const r of this.rings) {
        if (r.userData.done) continue;
        const dx = r.position.x - this.player.pos.x;
        const dz = r.position.z - this.player.pos.z;
        if (dx * dx + dz * dz < 20) {
          r.userData.done = true;
          r.visible = false;
          this.collected++;
          this.audio.beep(700 + this.collected * 60, 0.15, 0.25);
          if (this.collected >= this.rings.length) { this.finish(); return 0; }
          this.toast(`💠 ${this.collected} / ${this.rings.length}`, 900);
        }
      }
      this.ringGroup.children.forEach((r) => { if (!r.userData.done) r.rotateZ(dt * 2); });
    }

    // 直线加速赛：剩余距离 + 尾速统计
    if (this.mode === 'drag') {
      this.topSpeed = Math.max(this.topSpeed, Math.abs(this.player.speed));
      const remain = Math.max(0, this.dragEnd.distanceTo(this.player.pos));
      $('collect-val').textContent = `${Math.round(remain)} m`;
      if (remain < 15) {
        this.finish();
        return Math.max(0, this.crashShake);
      }
    }

    // 自由漫游：靠近活动光柱弹报名面板；光环常转
    if (this.mode === 'free') {
      let near = null;
      for (const ev of this.events) {
        if (ev.pos.distanceTo(this.player.pos) < ev.radius) { near = ev; break; }
      }
      if (!near) this.dismissedFor = null;                 // 先判"是否真的驶出范围"
      if (near && near === this.dismissedFor) near = null; // 再过滤已忽略的活动
      this.setPromptEvent(near);
      this.eventRings.forEach((r) => { r.rotation.z += dt * 1.5; });
    } else if (this.promptEvent) {
      this.setPromptEvent(null);
    }

    // HUD
    $('speed-val').textContent = Math.round(Math.abs(this.player.speed) * 3.6);
    $('time-val').textContent = fmtTime(this.elapsed);
    if (this.mode === 'race' || this.mode === 'time')
      $('lap-val').textContent = `${Math.min(this.lap, this.mode === 'race' ? LAPS_RACE : 1)} / ${this.mode === 'race' ? LAPS_RACE : 1}`;
    if (this.mode === 'race') {
      const rank = 1 + this.ais.filter((a) => a.group.visible && a.total > this.player.total).length;
      $('rank-val').textContent = `${rank} / ${this.ais.length + 1}`;
    }
    if (this.mode === 'collect')
      $('collect-val').textContent = `${this.collected} / ${this.rings.length}`;
    this.drawMinimap();

    // 引擎音
    this.audio.setSpeed(this.player.speed, true);

    // 相机抖动（高速 + 碰撞）
    return Math.max(
      Math.max(0, (Math.abs(this.player.speed) - 30) / 40),
      this.crashShake
    );
  }

  // ---- UI 绑定 ----
  bindUI() {
    // 模式入口：主菜单只有"开始自驾"（free）；其余模式经地图光柱活动面板进入，
    // 直接调用 startMode 仍可用于测试
    $('btn-restart').onclick = () => this.startMode(this.mode);
    $('btn-menu2').onclick = () => this.toMenu();
    $('btn-pause').onclick = () => this.togglePause();
    $('btn-join').onclick = () => this.acceptEvent();
    $('btn-dismiss').onclick = () => this.dismissPrompt();
    $('btn-roam').onclick = () => this.returnToFree();
    // 键盘 E 快捷报名
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'e' && this.promptEvent) this.acceptEvent();
    });
  }
}
