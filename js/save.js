// save.js — 存档管理器（v2.32）：localStorage 3 槽位 + 最近槽位指针 + 纪录迁移
// Schema 见 docs/DESIGN_GAME_SYSTEMS.md §1.2；单机离线，数据量 <2KB/槽位。
// 红线：绝不把 GLB/贴图等二进制入库；读档统一 normalize() 兜缺省字段。

const SLOT_KEYS = ['rg_save_slot0', 'rg_save_slot1', 'rg_save_slot2'];
const LAST_KEY = 'rg_save_last';
export const MAX_SLOTS = 3;
// 槽位内纪录键（含 v2.32 新赛事）
export const BEST_KEYS = ['race', 'time', 'drag', 'collect', 'sprint_highway', 'sprint_canyon', 'sprint_lakeside', 'offroad_stampede'];

function emptySlot(name) {
  return {
    v: 1,
    name: name || '新存档',
    created: Date.now(),
    lastPlayed: Date.now(),
    playMs: 0,
    car: 'ferrari',
    owned: ['ferrari'],
    credits: 0,
    odoTotal: 0,   // 累计里程（米）
    odoCarry: 0,   // 里程→积分的 <1000m 零头
    bests: BEST_KEYS.reduce((m, k) => { m[k] = null; return m; }, {}),
    raceLog: {},   // {eventKey: {plays, wins, bestRank}}
    pos: null,     // {x, z, yaw} 最近自由漫游位置
  };
}

// 读档兜底：缺字段按默认补齐（老档/手改档都能进游戏）
function normalize(raw) {
  const d = { ...emptySlot(), ...(raw || {}) };
  d.bests = { ...emptySlot().bests, ...(raw && raw.bests || {}) };
  d.owned = Array.isArray(d.owned) && d.owned.length ? d.owned : ['ferrari'];
  d.raceLog = d.raceLog || {};
  d.credits = Math.max(0, Math.floor(d.credits || 0));
  d.odoTotal = Math.max(0, d.odoTotal || 0);
  d.odoCarry = Math.max(0, Math.min(999, d.odoCarry || 0));
  d.playMs = Math.max(0, d.playMs || 0);
  return d;
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function safeDel(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }

export class SaveManager {
  constructor() {
    const n = parseInt(safeGet(LAST_KEY) ?? '-1', 10);
    this.lastSlot = Number.isInteger(n) && n >= 0 && n < MAX_SLOTS && this.read(n) ? n : -1;
  }

  // 槽位列表元数据（菜单卡片展示用，不反序列化整车库）
  listMeta() {
    const out = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const raw = safeGet(SLOT_KEYS[i]);
      out.push({ id: i, exists: !!raw, data: raw ? normalize(JSON.parse(raw)) : null });
    }
    return out;
  }

  // 读档（首次读取做全局纪录迁移：rg_best_* → 槽位 bests，迁移后清全局键防重复）
  read(i) {
    const raw = safeGet(SLOT_KEYS[i]);
    if (!raw) return null;
    let data;
    try { data = normalize(JSON.parse(raw)); } catch { return null; }
    if (!data._migrated) {
      let moved = false;
      for (const k of BEST_KEYS) {
        if (data.bests[k] != null) continue;
        const g = parseFloat(safeGet(`rg_best_${k}`) || '');
        if (g > 0) { data.bests[k] = g; moved = true; }
        safeDel(`rg_best_${k}`);
      }
      if (moved || Object.keys(data.raceLog).length || data.odoTotal > 0) data._migrated = 1;
      else data._migrated = 1;
      this.write(i, data);
    }
    return data;
  }

  write(i, data) {
    data.lastPlayed = Date.now();
    return safeSet(SLOT_KEYS[i], JSON.stringify(data));
  }

  // 新档：放到第一个空槽；满则返回 -1
  createSlot(carId) {
    const slots = this.listMeta();
    const id = slots.findIndex((s) => !s.exists);
    if (id < 0) return -1;
    const d = emptySlot();
    d.car = carId;
    d.owned = [carId];
    d._migrated = 1;
    this.write(id, d);
    this.lastSlot = id;
    safeSet(LAST_KEY, String(id));
    return id;
  }

  // 把游戏运行时状态刷进槽位（game 侧字段为权威来源）
  writeFromGame(game) {
    if (game.slotId < 0) return false;
    const d = this.read(game.slotId) || emptySlot();
    d.car = game.carId;
    d.owned = game.owned.slice();
    d.credits = game.credits;
    d.odoTotal = game.odoTotal;
    d.odoCarry = game.odoCarry;
    d.bests = { ...game.bests };
    d.raceLog = { ...game.raceLog };
    d.playMs = game.playMs + (Date.now() - game._sessionStart);
    // 只在自由漫游时记录位置（比赛中的临时传送点不该成为存档出生点）
    if (game.mode === 'free' && game.state === 'running') {
      d.pos = { x: game.player.pos.x, z: game.player.pos.z, yaw: game.player.yaw };
    } else if (d.pos === null && game._savedPos) {
      d.pos = game._savedPos;
    }
    this.write(game.slotId, d);
    this.lastSlot = game.slotId;
    safeSet(LAST_KEY, String(game.slotId));
    return true;
  }

  deleteSlot(i) { safeDel(SLOT_KEYS[i]); if (this.lastSlot === i) { this.lastSlot = -1; safeDel(LAST_KEY); } }
  renameSlot(i, name) { const d = this.read(i); if (d) { d.name = String(name).slice(0, 12) || '存档'; this.write(i, d); } }
}
