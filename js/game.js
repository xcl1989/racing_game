// game.js — 游戏逻辑：模式管理 / 检查点与圈数 / 收集挑战 / HUD / 小地图 / 导航
import * as THREE from 'three';
import { gyroState } from './input.js';
import { MapView } from './map-view.js';
import { buildNavGraph, findRoute, NavGuide } from './nav.js';
import { eventReward, markRaceResult, ODO_STEP, ODO_MIN_SPEED, ODO_FRAME_CAP } from './economy.js'; // v2.32 积分经济

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
    this.lastRoadPos = track.startPos.clone(); // 落水拖回的兜底点（起点格）
    // 漫游时世界路网（高速/乡道/城市街道）不算越野
    this.track.worldOnRoad = (pos) => this.world.onAnyRoad(pos);
    this.mode = 'free';
    this.state = 'menu';           // menu | countdown | running | paused | finished
    this.lap = 1; this.nextGate = 1;
    this.elapsed = 0; this.countdown = 0;
    this.lastT = 0;
    this.crashShake = 0; // 碰撞震屏强度（随时间衰减）
    this.dismissedFor = null; // 「稍后再说」忽略的活动（驶出范围后重置）

    // ---- v2.32 存档 / 积分经济（槽位由 main.js attachSave 注入）----
    this.slotId = -1;            // 当前存档槽位（-1 = 未挂存档，测试直开兼容）
    this.saveMgr = null;         // SaveManager 引用
    this.carId = 'ferrari';
    this.owned = ['ferrari'];
    this.credits = 0;
    this.odoTotal = 0;           // 累计里程 m
    this.odoCarry = 0;           // <1000m 零头
    this.bests = null;           // 槽位纪录表（null 时回退全局 rg_best_*）
    this.raceLog = {};
    this.playMs = 0;
    this._sessionStart = Date.now();
    this._autosaveT = 0;         // 自由漫游 60s 定时存档
    this._savedPos = null;       // 比赛中不覆盖存档位置（读档点兜底）
    this.sprint = null;          // {def, R, cursor, playerTotal, nextCp, cps, gates}

    this.mmZooms = [
      { label: '自动', range: 245, auto: true },
      { label: '200 m', range: 200 },
      { label: '600 m', range: 600 },
      { label: '全图', range: 0 },
    ];
    this.mmZoomIdx = 0;

    this.buildRings();
    this.buildEvents();
    this.mapView = new MapView(world, track, $('minimap'), $('bigMapCanvas'));
    this.mapView.events = this.events.map(e => ({ ...e, mapColor: `#${e.color.toString(16).padStart(6, '0')}` }));
    this.navGraph = buildNavGraph(this.world, this.track);
    this.navGuide = new NavGuide(this.track.gatesGroup.parent);
    this.nav = null;
    this.bindUI();
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
    // ---- v2.32 冲刺赛 ×3 + 越野赛 ×1（Forza 式点对点）----
    // 路线来自 world.sprintRoutes（ribbon 切片 / 野径扰动生成），零建模成本；
    // desc 里的里程按实际路线长度生成，基础奖励文案与 economy.js 奖励表一致
    const SR = this.world.sprintRoutes;
    const sprintDefs = [
      { key: 'sprint_highway', mode: 'sprint', route: SR.highway, name: '🏁 高速冲刺',
        desc: '高速直通段 · 3 名 AI · 首胜 +30💎', color: 0xff77cc },
      { key: 'sprint_canyon', mode: 'sprint', route: SR.canyon, name: '🏁 峡谷冲刺',
        desc: '国道 · 跨河大桥 · 3 名 AI · 首胜 +45💎', color: 0xff77cc },
      { key: 'sprint_lakeside', mode: 'sprint', route: SR.lakeside, name: '🏁 海滨冲刺',
        desc: '湖滨公路 · 3 名 AI · 首胜 +40💎', color: 0xff77cc },
      { key: 'offroad_stampede', mode: 'offroad', route: SR.offroad, name: '🌲 越野 · 湖东狂飙',
        desc: '野地检查点拉力 · 推荐越野车 · 首胜 +60💎', color: 0x88ff44 },
    ];
    for (const d of sprintDefs) {
      // 报名光柱立在起点路侧：试多个横向偏移，取第一个离所有路面 ≥6m 的位置
      //（湖滨路/国道起点在城市路口内，四面皆路 → 报名点顺路后挪到出城直段 6% 处）
      const R = d.route;
      const s0 = R.samples[Math.floor(R.samples.length * 0.06)];
      let pos = null;
      for (const off of [12, -12, 20, -20, 28, -28]) {
        const cand = s0.pos.clone().addScaledVector(s0.side, off).setY(0);
        if (this.world.distToRoads(cand.x, cand.z) > 6) { pos = cand; break; }
      }
      d.pos = pos || s0.pos.clone().addScaledVector(s0.side, 12).setY(0);
      d.radius = 16;
      d.desc = `${(R.length / 1000).toFixed(1)} km · ${d.desc}`;
      this.events.push(d);
    }
    this.sprintDefs = sprintDefs;
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

    // ---- v2.32 赛事检查点门组（每条路线独立 Group，仅该赛事进行中可见）----
    // 门=~350m 一座：两根发光柱 + 顶横梁；终点门加旗门横幅色带
    this.sprintGateGroups = {};
    const gateMat = (c) => new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 1.8, metalness: 0.3, roughness: 0.4,
    });
    for (const d of this.sprintDefs) {
      const g = new THREE.Group();
      const R = d.route;
      const nGates = Math.max(3, Math.round(R.length / 350)); // 含终点门
      d.gateDists = []; // 各门的曲线里程（进度判定用）
      for (let k = 1; k <= nGates; k++) {
        const isFinish = k === nGates;
        // 常规检查点均布至 92% 处；终点旗门压到末端 99.3%（冲线判定=全门通过）
        const t = isFinish ? 0.993 : (k / nGates) * 0.92;
        const p = R.curve.getPointAt(t);
        const tan = R.curve.getTangentAt(t).setY(0).normalize();
        const side = new THREE.Vector3(tan.z, 0, -tan.x);
        const half = R.width / 2 + 1.6;
        d.gateDists.push(t * R.length);
        for (const sgn of [-1, 1]) {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 5, 8), gateMat(d.color));
          pole.position.copy(p).addScaledVector(side, sgn * half).setY(2.5);
          g.add(pole);
        }
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry(half * 2 + 0.6, 0.28, 0.28),
          gateMat(isFinish ? 0xffdd44 : d.color)
        );
        beam.position.copy(p).setY(5.1);
        beam.rotation.y = Math.atan2(tan.x, tan.z) + Math.PI / 2;
        g.add(beam);
        if (isFinish) { // 终点旗门横幅
          const banner = new THREE.Mesh(
            new THREE.BoxGeometry(half * 2, 1.1, 0.06),
            new THREE.MeshBasicMaterial({ color: 0x111418, transparent: true, opacity: 0.85 })
          );
          banner.position.copy(p).setY(4.4);
          banner.rotation.y = beam.rotation.y;
          g.add(banner);
        }
      }
      g.visible = false;
      scene.add(g);
      this.sprintGateGroups[d.key] = g;
    }
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

  drawMinimap() { this.mapView.drawMini(this); }

  // ---- 模式启动 ----
  startMode(mode, ev = null) {
    this.mode = mode;
    this.sprint = null;
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
    } else if (mode === 'sprint' || mode === 'offroad') {
      // ---- v2.32 冲刺/越野赛：单向路线点对点，检查点门按序通过 ----
      const def = ev && ev.route ? ev
        : this.sprintDefs.find((d) => d.mode === mode) || this.sprintDefs[0];
      const R = def.route;
      const tan0 = R.curve.getTangentAt(0).setY(0).normalize();
      const side0 = new THREE.Vector3(tan0.z, 0, -tan0.x);
      const lanes = mode === 'offroad' ? [-3.5, -1.2, 1.2, 3.5] : [-4, -1.4, 1.4, 4];
      this.player.reset(R.startPos.clone().addScaledVector(side0, lanes[3]), Math.atan2(tan0.x, tan0.z));
      // 进度游标 + 检查点里程表（按序通过，进度单调推进防倒车刷门）
      this.sprint = {
        def, R, cursor: 0, playerTotal: 0, nextCp: 0,
        cps: def.gateDists, aiFinished: [null, null, null],
      };
      this.ais.forEach((ai, i) => ai.resetSprint(R, lanes[i]));
      this._activeKey = def.key;
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
    const sprintLike = mode === 'sprint' || mode === 'offroad';
    const showAI = mode === 'race' || sprintLike; // 冲刺/越野赛 AI 同场竞技
    this.track.gatesGroup.visible = raceLike;
    this.ringGroup.visible = mode === 'collect';
    this.eventGroup.visible = mode === 'free'; // 光柱只在漫游时可见
    // ★ 赛事门组：只亮当前赛事的（其余全隐藏，含离开时熄灭）
    for (const [k, g] of Object.entries(this.sprintGateGroups)) {
      g.visible = sprintLike && this.sprint && this.sprint.def.key === k;
    }
    // ★ 护栏仅主环道比赛时出现（漫游自由越野，直线赛道开阔，冲刺赛跑公共路不设栏）
    if (this.track.railGroup) this.track.railGroup.visible = raceLike;
    this.ais.forEach((a) => { a.group.visible = showAI; });
    // 自由漫游：AI 车随机相位分散到环道各处巡航（不再停在起步格"陪着"玩家）
    if (mode === 'free') {
      this.ais.forEach((ai) => {
        ai.group.visible = true;
        ai.total = Math.random() * this.track.length;
        ai.speed = 0;
        ai.reaction = 0.2 + Math.random() * 0.5;
        ai.place(this.track);
      });
    }
    // NPC 车流只在漫游/收集时出现（比赛让路，直线赛道空旷）
    this.traffic.forEach((t) => { t.group.visible = mode === 'free' || mode === 'collect'; });
    for (const r of this.rings) r.userData.done = false;

    $('menu').style.display = 'none';
    $('result').style.display = 'none';
    $('pauseMenu').style.display = 'none'; // 直调 startMode（测试）时兜底清掉暂停菜单
    $('hud').style.display = 'block';
    $('controls').style.display = 'flex';
    // 收集挑战显示已收集数；直线加速赛复用该栏显示剩余距离；冲刺赛显示检查点进度
    const infoBox = mode === 'collect' ? 'collect'
      : (mode === 'drag' ? 'drag' : (sprintLike ? 'cp' : null));
    $('collect-label').textContent = infoBox === 'cp' ? '检查点'
      : (infoBox === 'drag' ? '剩余' : '能量环');
    $('collect-box').style.display = infoBox ? 'block' : 'none';
    $('collect-val').textContent = infoBox === 'drag' ? '760 m'
      : (infoBox === 'cp' ? `0 / ${this.sprint.cps.length}` : '0 / 14');
    $('lap-box').style.display = raceLike ? 'block' : 'none';
    $('rank-box').style.display = mode === 'race' || sprintLike ? 'block' : 'none';
    // v2.32：sprint 分支文案延迟取值（对象字面量会急切求值，free 模式下 sprint 为 null）
    const defName = this.sprint ? this.sprint.def.name.replace(/^🏁 |^🌲 /, '') : '';
    const modeName = {
      race: '🏁 竞速赛 3圈', time: '⏱ 计时赛 1圈', collect: '💠 收集挑战',
      drag: '🚀 直线加速赛', free: '🌊 自由漫游',
      sprint: `🏁 冲刺赛 · ${defName}`,
      offroad: `🌲 越野赛 · ${defName}`,
    };
    $('mode-val').textContent = modeName[mode];
    // 赛事纪录键：环道四模式用 mode 名，冲刺/越野用事件 key（同模式多路线）
    this._activeKey = this._activeKey || mode;
    if (!sprintLike) this._activeKey = mode;
    const best = this.getBest(this._activeKey);
    $('best-line').style.display = best ? 'block' : 'none';
    if (best) $('best-val').textContent = fmtTime(parseFloat(best));
    if (mode === 'free') {
      this.toast('开到地图上的彩色光柱即可报名比赛', 3500);
    } else {
      this.toast('准备…', 1200);
      // 陀螺仪不可用时仍可使用触屏方向键。
      if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) && !gyroState.enabled) {
        this.toast('可用屏幕方向键转向，也可在主菜单开启陀螺仪', 3500);
      }
    }
  }

  toMenu() {
    this.save(); // v2.32：回主菜单 = 存档触发点 4
    this.state = 'menu';
    this._stateBeforePause = null;
    this._savedPos = this.mode === 'free' && this.slotId >= 0
      ? { x: this.player.pos.x, z: this.player.pos.z, yaw: this.player.yaw }
      : this._savedPos; // 记住漫游位置供存档兜底（比赛中不动）
    $('pauseMenu').style.display = 'none'; // 暂停菜单兜底隐藏
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
    if ($('bigMap').style.display !== 'none') { this.closeBigMap(); return; }
    if (this.state === 'running' || this.state === 'countdown') {
      this._stateBeforePause = this.state; // 保存暂停前状态（倒计时中暂停 → 回到倒计时）
      this.state = 'paused';
      this.toast('⏸ 已暂停', 1500);
      $('pauseMenu').style.display = 'flex'; // v2.19.2：暂停菜单（回到游戏 / 返回主界面）
      this.audio.setSpeed(0, false);
    } else if (this.state === 'paused') {
      // 恢复暂停前的状态（倒计时中暂停 → 回到倒计时，不跳秒）
      $('pauseMenu').style.display = 'none';
      this.state = this._stateBeforePause || 'running';
      this._stateBeforePause = null;
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

  openBigMap() {
    if (!['running', 'countdown', 'paused'].includes(this.state) || $('bigMap').style.display !== 'none') return;
    this._mapFocus = document.activeElement;
    if (this.state !== 'paused') {
      this._stateBeforeMap = this.state;
      this.state = 'paused';
    }
    $('bigMap').style.display = 'flex';
    this.bigPick = null;
    $('btn-nav-go').disabled = true;
    $('bm-hint').textContent = '点地图或选择区域；确认后开始导航。';
    $('btn-nav-cancel-route').style.display = this.nav ? '' : 'none';
    this.drawBigMap();
    $('btn-bigmap-close').focus({ preventScroll: true });
    this.audio.setSpeed(0, false);
    this.audio.beep(520, 0.1, 0.15);
  }

  closeBigMap() {
    if ($('bigMap').style.display === 'none') return;
    $('bigMap').style.display = 'none';
    if (this._stateBeforeMap && this.state === 'paused') this.state = this._stateBeforeMap;
    this._stateBeforeMap = null;
    this._mapFocus?.focus({ preventScroll: true });
    this._mapFocus = null;
  }

  setMapPick(x, z, name) {
    this.bigPick = { x, z, name };
    $('btn-nav-go').disabled = false;
    $('bm-hint').textContent = `目的地：${name}`;
    this.drawBigMap();
    this.audio.beep(700, 0.08, 0.12);
  }

  pickBigMap(ev) {
    const cv = $('bigMapCanvas');
    const r = cv.getBoundingClientRect();
    const size = cv.clientWidth;
    const mx = (ev.clientX - r.left - cv.clientLeft) * cv.width / size;
    const my = (ev.clientY - r.top - cv.clientTop) * cv.height / size;
    const candidates = this.events.map(e => ({ name: e.name, target: e.pos }));
    for (const region of this.world.guide) if (region.target) candidates.push(region);
    let best = null, distance = 11;
    for (const candidate of candidates) {
      const { x, z } = candidate.target;
      const [sx, sy] = this.mapView.project(x, z);
      const d = Math.hypot(sx - mx, sy - my) * size / cv.width;
      if (d < distance) { best = candidate; distance = d; }
    }
    const [wx, wz] = this.mapView.unproject(mx, my);
    this.setMapPick(best?.target.x ?? wx, best?.target.z ?? wz, best?.name ?? '自定义目的地');
  }

  drawBigMap() { this.mapView.drawBig(this); }

  setNavDest(pos, name) {
    this.closeBigMap();
    this.computeRoute(pos, name);
    if (!this.nav) return;
    this.toast(`🧭 导航：${name}`, 2200);
    $('nav-box').style.display = 'block';
    this.audio.beep(760, 0.12, 0.2);
  }

  computeRoute(pos, name) {
    const res = findRoute(this.navGraph, this.player.pos.x, this.player.pos.z, pos.x, pos.z);
    const full = [new THREE.Vector3(this.player.pos.x, 0, this.player.pos.z)];
    let fallback = false, hops = 0;
    if (res) {
      for (const p of res.pts) {
        const v = new THREE.Vector3(p.x, p.y, p.z);
        v.w = p.w;
        full.push(v);
      }
      hops = res.hops || 0;
    } else {
      // 目的地离任何路网节点都太远（>40m，如空地/野地深处）：直线引导兜底
      full.push(new THREE.Vector3(pos.x, 0, pos.z));
      fallback = true;
    }
    full.push(new THREE.Vector3(pos.x, pos.y || 0, pos.z));
    // 累计里程表（剩余距离用）
    const cum = [0];
    for (let i = 1; i < full.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(full[i].x - full[i - 1].x, full[i].z - full[i - 1].z));
    }
    this.nav = { name, dest: new THREE.Vector3(pos.x, pos.y || 0, pos.z), pts: full, cum, cursor: 0, rerouteT: 0, fallback, hops };
    if (fallback) this.navGuide.clear();
    else this.navGuide.setRoute(full);
  }

  clearNav() {
    this.nav = null;
    this.navGuide.clear();
    $('nav-box').style.display = 'none';
  }

  navTick(dt) {
    const nv = this.nav;
    if (!nv) return;
    const box = $('nav-box');
    if (this.mode !== 'free' || this.state !== 'running') {
      this.navGuide.group.visible = false;
      box.style.display = 'none';
      return;
    }
    this.navGuide.group.visible = !nv.fallback;
    if (!nv.fallback) this.navGuide.update(dt);
    box.style.display = 'block';

    const p = this.player.pos;
    // 最近路径段（游标窗口搜索防高速跳变）
    let best = Infinity, bi = nv.cursor, bt = 0;
    const lo = Math.max(0, nv.cursor - 40), hi = Math.min(nv.pts.length - 1, nv.cursor + 40);
    for (let k = lo; k < hi; k++) {
      const a = nv.pts[k], b = nv.pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
      if (d < best) { best = d; bi = k; bt = t; }
    }
    nv.cursor = bi;
    // 偏航 >45m 持续 1.2s → 就近重算；路网不通则保持直线兜底
    if (best > 45) {
      nv.rerouteT += dt;
      if (nv.rerouteT > 1.2) {
        nv.rerouteT = 0;
        const old = nv;
        this.computeRoute(nv.dest, nv.name);
        if (this.nav && !this.nav.fallback) this.toast('🧭 已重新规划路线', 1600);
        else if (!this.nav) this.nav = old;
      }
    } else nv.rerouteT = 0;
    // 剩余距离 = 全程 − 已走（游标段投影进度）+ 到路径的横向残差
    const segLen = nv.cum[bi + 1] - nv.cum[bi];
    const remain = nv.cum[nv.cum.length - 1] - (nv.cum[bi] + segLen * bt) + best;
    $('nav-val').textContent = `${Math.max(0, Math.round(remain))} m${nv.fallback ? ' ·直线' : (nv.hops ? ' ·含越野' : '')}`;
    // 到达判定
    if (Math.hypot(p.x - nv.dest.x, p.z - nv.dest.z) < 20) {
      const name = nv.name;
      this.clearNav();
      this.toast(`🧭 已到达：${name}`, 2500);
    }
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

  // ---- v2.33 碰撞体系 ----
  // 车身双圆采样：前/后轴各一个碰撞圆（车长 4.5m，单圆会把侧面碰撞判得太晚太深）
  static carCircles(pos, yaw, r = 1.05, off = 1.25) {
    const cx = Math.sin(yaw), cz = Math.cos(yaw);
    return [
      { x: pos.x + cx * off, z: pos.z + cz * off, r },
      { x: pos.x - cx * off, z: pos.z - cz * off, r },
    ];
  }

  // 玩家 × AI：双圆检测，最深穿透对响应。
  // 玩家：法向反弹（相对速度弹性 0.35）+ 位置分离 + 横摆扰动；AI：total/speed 惩罚（其位置由路线派生）
  carVsCar(player, ai, withSound) {
    const pc = Game.carCircles(player.pos, player.yaw);
    const ac = Game.carCircles(ai.pos, ai.yaw);
    let deepest = null;
    for (const a of pc) {
      for (const b of ac) {
        const dx = a.x - b.x, dz = a.z - b.z;
        const d = Math.hypot(dx, dz), rr = a.r + b.r;
        if (d < rr && d > 0.001) {
          const pen = rr - d;
          if (!deepest || pen > deepest.pen) deepest = { pen, nx: dx / d, nz: dz / d, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2 };
        }
      }
    }
    if (!deepest) return;
    const { pen, nx, nz, cx, cz } = deepest;
    // 分离：玩家位置推开全部穿透量（AI 位置是派生的，推不动，用 total 惩罚表达）
    player.pos.x += nx * pen;
    player.pos.z += nz * pen;
    // 法向弹性反弹（e=0.35）：按速度矢量在碰撞法线上的投影算——
    // 正撞掉速多、侧面擦蹭几乎不掉速（vN/v 比例即对齐度）
    const vy = player.travelYaw ?? player.yaw;
    const fX = Math.sin(vy), fZ = Math.cos(vy);
    const vn = player.speed * (fX * nx + fZ * nz); // >0 = 撞向对方，<0 = 倒车撞
    const vnAbs = Math.abs(vn);
    if (vnAbs > 0.5 && Math.abs(player.speed) > 1) {
      const ratio = Math.min(1, vnAbs / Math.abs(player.speed)); // 撞击对齐度
      player.speed *= Math.sqrt(Math.max(0.08, 1 - 0.88 * ratio * ratio)); // e=0.35 反弹
      // 横摆扰动：撞击点在车身的横向力臂决定车头被带偏的方向
      const lat = (cx - player.pos.x) * Math.cos(player.yaw) - (cz - player.pos.z) * Math.sin(player.yaw);
      player.driftYaw += Math.sign(lat || 1) * Math.min(0.3, ratio * 0.35);
      // AI 惩罚：被撞退 + 掉速（其位置由路线派生）
      ai.total = Math.max(ai.total - pen * 1.2, 0);
      if (ai.speed != null) ai.speed *= 0.72;
      if (withSound) {
        const impact = Math.min(1, vnAbs / 22);
        if (impact > 0.08) {
          this.crashShake = Math.max(this.crashShake, 0.3 + impact * 0.5);
          this.audio.crash(impact);
        }
      }
    }
  }

  // AI × AI：只交换 total/speed 惩罚（位置派生，无音效）
  aiVsAi(a, b) {
    const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 3.2 && d > 0.01) {
      const overlap = (3.2 - d) * 0.5;
      const lead = a.total > b.total ? a : b;   // 后车撞前车：后车减速
      const rear = a.total > b.total ? b : a;
      rear.total = Math.max(rear.total - overlap, 0);
      rear.speed = Math.min(rear.speed, lead.speed * 0.9);
    }
  }

  // 玩家 × 建筑群：双圆 × AABB，推出 + 法向反弹 + 音效/震屏
  carVsBuildings(dt) {
    const cols = this.world.bldColliders;
    if (!cols || !cols.length) return;
    const p = this.player;
    const pc = Game.carCircles(p.pos, p.yaw);
    for (const b of cols) {
      for (const c of pc) {
        // 粗筛：圆心离 AABB 外扩圆太远直接跳过
        const rx = c.x - b.x, rz = c.z - b.z;
        if (rx * rx + rz * rz > (b.hw + b.hd + c.r) * (b.hw + b.hd + c.r)) continue;
        // 最近点
        const qx = Math.max(b.x - b.hw, Math.min(c.x, b.x + b.hw));
        const qz = Math.max(b.z - b.hd, Math.min(c.z, b.z + b.hd));
        let dx = c.x - qx, dz = c.z - qz;
        let d = Math.hypot(dx, dz);
        if (d >= c.r) continue;
        if (d < 0.001) { // 圆心在楼内：沿最浅轴推出
          const px = b.hw + c.r - Math.abs(rx), pz = b.hd + c.r - Math.abs(rz);
          if (px < pz) { dx = Math.sign(rx) || 1; dz = 0; d = 0.001; }
          else { dx = 0; dz = Math.sign(rz) || 1; d = 0.001; }
          const push = Math.min(px, pz);
          p.pos.x += dx * push; p.pos.z += dz * push;
        } else {
          dx /= d; dz /= d;
          p.pos.x += dx * (c.r - d);
          p.pos.z += dz * (c.r - d);
        }
        // 法向速度反弹：法线从楼指向车外，速度朝楼 = nDotF < 0
        // 正撞（|-nDotF|≈1）几乎撞停 ×0.15，斜擦（≈0.2）×0.83 滑过
        const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
        const nDotF = dx * sinY + dz * cosY;
        if (nDotF < -0.05) { // 正在撞向楼
          const align = -nDotF;                     // 撞击对齐度 0~1
          const vn = Math.abs(p.speed) * align;     // 法向撞击速度
          p.speed *= 1 - align * 0.85;
          p.driftYaw += (Math.random() - 0.5) * align * 0.3;
          if (vn > 3) {
            this.crashShake = Math.max(this.crashShake, Math.min(0.85, 0.25 + vn / 30));
            this.audio.crash(Math.min(1, vn / 25));
          }
        }
      }
    }
  }

  // ---- v2.32 存档 / 积分 / 车库 ----
  // 纪录读写：有槽位走槽位表，否则回退全局 rg_best_*（测试直开模式兼容）
  getBest(key) {
    if (this.bests) return this.bests[key] || null;
    const v = parseFloat(localStorage.getItem(`rg_best_${key}`) || '');
    return v > 0 ? v : null;
  }
  setBest(key, t) {
    if (this.bests) {
      if (!this.bests[key] || t < this.bests[key]) { this.bests[key] = t; return true; }
      return false;
    }
    const cur = parseFloat(localStorage.getItem(`rg_best_${key}`) || '');
    if (!cur || t < cur) { localStorage.setItem(`rg_best_${key}`, t.toFixed(1)); return true; }
    return false;
  }
  owns(id) { return this.owned.includes(id); }
  buy(spec) {
    if (this.owns(spec.id) || this.credits < spec.price) return false;
    this.credits -= spec.price;
    this.owned.push(spec.id);
    this.save();
    return true;
  }
  // main.js 读档后注入：槽位数据 → 游戏状态
  attachSave(slotId, data, saveMgr) {
    this.slotId = slotId;
    this.saveMgr = saveMgr || this.saveMgr;
    this.carId = data.car;
    this.owned = data.owned.slice();
    this.credits = data.credits;
    this.odoTotal = data.odoTotal;
    this.odoCarry = data.odoCarry;
    this.bests = { ...data.bests };
    this.raceLog = { ...data.raceLog };
    this.playMs = data.playMs;
    this._sessionStart = Date.now();
    this._savedPos = data.pos;
  }
  // 写档（槽位未挂时静默跳过——测试直开模式）
  save() {
    if (this.slotId >= 0 && this.saveMgr) this.saveMgr.writeFromGame(this);
  }

  acceptEvent() {
    if (!this.promptEvent) return;
    const ev = this.promptEvent;
    this.returnPos = this.player.pos.clone(); // 完赛后送回报名点
    this.setPromptEvent(null);
    this.startMode(ev.mode, ev);
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
    const sprintLike = this.mode === 'sprint' || this.mode === 'offroad';
    const key = this._activeKey;
    // 名次：环道按里程；冲刺/越野按冲线时间（完赛早于我方者排前面）
    let rank = 0;
    if (this.mode === 'race') {
      rank = 1 + this.ais.filter((a) => a.total > this.player.total).length;
    } else if (sprintLike) {
      rank = 1 + this.ais.filter((a) => a.finishTime != null && a.finishTime <= this.elapsed).length;
    }
    if (this.mode === 'race' || sprintLike) {
      title = rank === 1 ? '🏆 冠军！' : `第 ${rank} 名`;
      line = `用时 ${fmtTime(this.elapsed)}`;
    } else if (this.mode === 'drag') {
      title = '🚀 冲线！';
      line = `用时 ${fmtTime(this.elapsed)} · 尾速 ${Math.round(this.topSpeed * 3.6)} km/h`;
    }
    // 纪录（槽位表优先，测试无档时回退全局键）
    const isRecord = this.setBest(key, this.elapsed);
    if (this.mode === 'drag') {
      if (isRecord) line += `（新纪录！）`;
    } else if (this.mode !== 'race' && this.mode !== 'free') {
      const best = this.getBest(key);
      if (isRecord) line += ` · 新纪录 ${fmtTime(this.elapsed)}！`;
      else if (this.mode !== 'collect') line += ` · 纪录 ${fmtTime(best)}`;
    }
    // ---- 积分结算（v2.32）：名次奖 + 破纪录翻倍 + 首胜加成，写入槽位 ----
    let reward = 0;
    if (this.slotId >= 0 && key) {
      reward = eventReward(key, rank, isRecord, this.raceLog);
      if (reward > 0) {
        this.credits += reward;
        markRaceResult(key, rank, this.raceLog);
        line += `\n💎 +${reward} 积分（余额 ${this.credits}）`;
      }
      this.save(); // 比赛结算 = 存档触发点 1
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
      this.drawMinimap();
      return 0;
    }

    this.elapsed += dt;

    // 玩家物理（含桥面高度平滑过渡）
    const groundY = this.world ? this.world.heightAt(this.player.pos) : 0;
    const res = this.player.update(dt, input, this.track, groundY);

    // 落水处理（v2.12）：水面下强减速熄火，1.8s 后拖车拽回最近路面点
    {
      // v2.23.2 落水判定加"在路上豁免"：湖东野径贴岸段地形 -1.16（水面 -1.5 之上），
      // 车贴地形走到 -1.0 以下被误判落水 → 拖回 → 再上路 → 死循环（用户报"过不去"）。
      // 设计红线本就规定路永不沉水：offroad=false（在公路/野径/桥上）时低高度全是
      // 采样假阳性（贴岸坡带/桥下河床），只有真冲出路面才判落水。
      const inWater = this.player.pos.y < -1.0 && this.player.offroad;
      if (inWater) {
        const p = this.player;
        p.speed *= Math.max(0, 1 - 2.8 * dt); // 水阻：几秒内熄火
        p.pos.y += (groundY - p.pos.y) * Math.min(1, dt * 15); // 快速下沉（别再滑行）
        if (!this._wasInWater) { // 入水瞬间：水花 + 闷响
          for (let k = 0; k < 12; k++) {
            this.smoke.emit(
              p.pos.x + (Math.random() - 0.5) * 3,
              -0.9,
              p.pos.z + (Math.random() - 0.5) * 3
            );
          }
          this.audio.crash(0.5);
        }
        this.waterT = (this.waterT || 0) + dt;
        if (this.waterT > 1.8) {
          if (this.lastRoadPos) {
            p.pos.copy(this.lastRoadPos);
            p.pos.y = this.world ? this.world.heightAt(p.pos) : 0;
          }
          p.speed = 0;
          p.hint = -1;
          this.toast('💦 落水！拖车已把你拽回路面', 2800);
          this.audio.beep(220, 0.3, 0.15);
          this.waterT = 0;
        }
      } else {
        this.waterT = 0;
        // 记录最近的安全路面点（世界路网或主赛道上都算，随时可回）
        if (this.player.pos.y > -0.5) {
          const p = this.player.pos;
          if ((this.world && this.world.onAnyRoad(p)) || !this.track.isOffroad(p, -1).off) {
            this.lastRoadPos = p.clone();
          }
        }
      }
      this._wasInWater = inWater;
    }
    if (res.dust || res.drifting) {
      const back = this.player.pos.clone();
      back.x -= Math.sin(this.player.yaw) * 1.6;
      back.z -= Math.cos(this.player.yaw) * 1.6;
      back.y += 0.3; // 跟随车底（山地/桥面不射进地里）
      this.dust.emit(back.x, back.y, back.z, res.drifting ? 3 : 1);
    }
    // 漂移/重刹：后轮落胎痕 + 冒白烟
    if (res.skid) {
      const p = this.player;
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      for (const lx of [-0.92, 0.92]) {
        const wx = p.pos.x + lx * cy - 1.35 * sy;
        const wz = p.pos.z - lx * sy - 1.35 * cy;
        this.skids.add(wx, wz, p.yaw, p.pos.y); // 山地/桥面胎痕跟随车底高度
        if (res.drifting) this.smoke.emit(wx, 0.4, wz);
      }
    }
    // 护栏剐蹭：震屏 + 碰撞音
    if (res.wallHit > 0.05) {
      this.crashShake = Math.max(this.crashShake, res.wallHit * 0.5);
      this.audio.crash(res.wallHit);
    }

    // ★ 车对车碰撞（v2.33 重做：双圆近似车身 + 法向弹性反弹）
    // 旧版单圆 2.9m：车长 4.5m 导致侧面擦碰判定过晚，且只有位置糊推没有反弹 → "假"
    // 比赛唯一推进点在此（sprint 用 updateSprint、free 用 updateTraffic，各自的模式块推进）
    for (const ai of this.ais) {
      if (!ai.group.visible) continue;
      if (this.mode === 'race') ai.update(dt, this.track, this.player.total);
      this.carVsCar(this.player, ai, true);
    }
    // AI × AI（比赛/冲刺赛中互相碰撞，位置由 total 派生 → 只调 total/speed，不出音效防嘈杂）
    if (this.ais.length >= 2 && this.mode !== 'free') {
      for (let i = 0; i < this.ais.length; i++) {
        for (let j = i + 1; j < this.ais.length; j++) {
          const a = this.ais[i], b = this.ais[j];
          if (!a.group.visible || !b.group.visible) continue;
          this.aiVsAi(a, b);
        }
      }
    }
    // ★ 建筑碰撞（v2.33）：城市楼群 AABB × 玩家双圆，推出 + 法向反弹 + 音效震屏
    this.carVsBuildings(dt);
    // 撞击震屏衰减
    this.crashShake = Math.max(0, this.crashShake - dt * 1.6);

    // ---- v2.32 里程积分（每 1km=1 分，全模式）+ 自由漫游定时存档 ----
    {
      const v = Math.abs(this.player.speed);
      if (v >= ODO_MIN_SPEED) {
        const step = Math.min(v * dt, ODO_FRAME_CAP); // 单帧钳位防大 dt 刷分
        this.odoCarry += step;
        this.odoTotal += step;
        let gained = 0;
        while (this.odoCarry >= ODO_STEP) { this.odoCarry -= ODO_STEP; gained++; }
        if (gained > 0) {
          this.credits += gained;
          if (this.mode === 'free') this.toast(`💎 里程积分 +${gained}`, 1200); // 比赛中安静攒，结算一起给
        }
      }
      if (this.mode === 'free' && this.state === 'running') {
        this._autosaveT += dt;
        if (this._autosaveT >= 60) { this._autosaveT = 0; this.save(); } // 存档触发点 3
      }
    }

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

    // 自由漫游：环道环境车流（竞速 AI 转岗，固定车速巡航，无橡皮筋）
    if (this.mode === 'free') {
      for (const ai of this.ais) {
        if (ai.group.visible) ai.updateTraffic(dt, this.track);
      }
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

    // ---- 冲刺/越野赛（v2.32）：玩家进度投影 + 检查点 + AI + 冲线 ----
    if (this.mode === 'sprint' || this.mode === 'offroad') {
      const sp = this.sprint, R = sp.R;
      // 玩家沿路线的曲线里程：窗口最近段投影（游标 ±40 段防高速跳变，同 navTick 法）。
      // samples 由 getPointAt 均匀参数生成 → 弧长均匀，索引 i ≈ 里程 i·per
      const p = this.player.pos;
      let best = Infinity, bi = sp.cursor, bt = 0;
      const lo = Math.max(0, sp.cursor - 40), hi = Math.min(R.samples.length - 1, sp.cursor + 40);
      for (let k = lo; k < hi; k++) {
        const a = R.samples[k].pos, b = R.samples[k + 1].pos;
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz || 1;
        let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
        if (d < best) { best = d; bi = k; bt = t; }
      }
      sp.cursor = bi;
      const per = R.length / (R.samples.length - 1);
      sp.playerTotal = Math.min(R.length, (bi + bt) * per);
      // 检查点按序通过（进度单调 → 倒车回去再前进不会重复计数）
      while (sp.nextCp < sp.cps.length && sp.playerTotal >= sp.cps[sp.nextCp]) {
        sp.nextCp++;
        this.audio.beep(700 + sp.nextCp * 40, 0.12, 0.2);
        $('collect-val').textContent = `${sp.nextCp} / ${sp.cps.length}`;
        if (sp.nextCp < sp.cps.length) this.toast(`检查点 ${sp.nextCp} / ${sp.cps.length}`, 900);
        else this.toast('冲线！', 900);
      }
      // AI 冲线计时 + 实时名次
      this.ais.forEach((ai) => {
        ai.updateSprint(dt, R, sp.playerTotal);
        if (ai.finished && ai.finishTime == null) ai.finishTime = this.elapsed;
      });
      const rk = 1 + this.ais.filter((a) =>
        (a.finishTime != null && a.finishTime <= this.elapsed) ||
        (a.finishTime == null && a.total > sp.playerTotal)).length;
      $('rank-val').textContent = `${rk} / ${this.ais.length + 1}`;
      // 冲线：全门通过（终点门即最后一门，位于路线 99.3% 处）
      if (sp.nextCp >= sp.cps.length) {
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
    const kmh = Math.round(Math.abs(this.player.speed) * 3.6);
    $('speed-val').textContent = kmh;
    const sf = $('speed-fill');
    if (sf) sf.style.width = Math.min(100, (kmh / 180) * 100) + '%'; // 速度条 0~180km/h
    $('time-val').textContent = fmtTime(this.elapsed);
    if (this.mode === 'race' || this.mode === 'time')
      $('lap-val').textContent = `${Math.min(this.lap, this.mode === 'race' ? LAPS_RACE : 1)} / ${this.mode === 'race' ? LAPS_RACE : 1}`;
    if (this.mode === 'race') {
      const rank = 1 + this.ais.filter((a) => a.group.visible && a.total > this.player.total).length;
      $('rank-val').textContent = `${rank} / ${this.ais.length + 1}`;
    }
    if (this.mode === 'collect')
      $('collect-val').textContent = `${this.collected} / ${this.rings.length}`;
    $('credit-val').textContent = this.credits; // v2.32 积分常显
    this.navTick(dt); // 导航：进度/偏航重算/到达判定（v2.18）
    this.drawMinimap();

    // 引擎音（v2.26：油门双变量调制——地板油透亮、松油回闷）
    this.audio.setSpeed(this.player.speed, true, this.player.throttleSm);

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
    // 冲刺/越野赛重启要带回原路线（同 mode 多路线，缺省 find 只会拿第一条）
    $('btn-restart').onclick = () => this.startMode(this.mode, this.sprint ? this.sprint.def : null);
    $('btn-menu2').onclick = () => this.toMenu();
    $('btn-pause').onclick = () => this.togglePause();
    $('btn-join').onclick = () => this.acceptEvent();
    $('btn-dismiss').onclick = () => this.dismissPrompt();
    $('btn-roam').onclick = () => this.returnToFree();
    // 暂停菜单（v2.19.2）
    $('btn-resume').onclick = () => this.togglePause();
    $('btn-pause-menu').onclick = () => this.toMenu();
    const mm = $('btn-minimap');
    let press = null, startX, startY, skipClick = false;
    const cancelPress = () => { clearTimeout(press); press = null; };
    mm.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) return;
      skipClick = false; startX = e.clientX; startY = e.clientY;
      cancelPress();
      press = setTimeout(() => { skipClick = true; this.openBigMap(); }, 450);
    });
    mm.addEventListener('pointermove', e => {
      if (press !== null && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
        skipClick = true; cancelPress();
      }
    });
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) mm.addEventListener(event, cancelPress);
    mm.addEventListener('contextmenu', e => e.preventDefault());
    mm.onclick = e => {
      if (skipClick && e.detail) { skipClick = false; return; }
      this.mmZoomIdx = (this.mmZoomIdx + 1) % this.mmZooms.length;
      mm.setAttribute('aria-label', `小地图：${this.mmZooms[this.mmZoomIdx].label}，点按切换范围`);
      this.mapView.lastMini = -Infinity;
      this.drawMinimap();
      this.audio.beep(660, 0.08, 0.1);
    };
    $('btn-open-map').onclick = () => this.openBigMap();
    for (const region of this.world.guide) if (region.target) {
      const button = document.createElement('button');
      button.textContent = region.name;
      button.onclick = () => this.setMapPick(region.target.x, region.target.z, region.name);
      $('bm-regions').appendChild(button);
    }
    $('bigMapCanvas').addEventListener('pointerdown', e => { if (e.isPrimary && e.button === 0) this.pickBigMap(e); });
    $('btn-nav-go').onclick = () => {
      if (!this.bigPick) return;
      this.setNavDest(
        new THREE.Vector3(this.bigPick.x, 0, this.bigPick.z),
        this.bigPick.name
      );
    };
    $('btn-bigmap-close').onclick = () => this.closeBigMap();
    $('btn-nav-cancel-route').onclick = () => {
      this.clearNav();
      this.closeBigMap();
      this.toast('🧭 已取消导航', 1600);
    };
    // 键盘 E 快捷报名
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if ($('bigMap').style.display !== 'none') {
        if (key === 'm') this.closeBigMap();
        return;
      }
      if (key === 'm') this.openBigMap();
      if (key === 'e' && this.state === 'running' && this.promptEvent) this.acceptEvent();
    });
  }
}

