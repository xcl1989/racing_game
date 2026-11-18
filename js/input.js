// input.js — 键盘 + 手机触屏虚拟按键统一输入
// 对外暴露 input 对象：throttle(0..1) brake(0/1) steer(-1..1) handbrake(bool)

export const input = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
};

const keys = {};

function refresh() {
  input.throttle = (keys['w'] || keys['arrowup']) ? 1 : 0;
  input.brake = (keys['s'] || keys['arrowdown']) ? 1 : 0;
  // 手机转向 = 纯陀螺仪；键盘 A/D 保留给桌面端
  input.steer = 0;
  if (keys['a'] || keys['arrowleft']) input.steer -= 1;
  if (keys['d'] || keys['arrowright']) input.steer += 1;
  if (touch.gas) input.throttle = 1;
  if (touch.brake) input.brake = 1;
  // 定速巡航（AUTO）：保持当前速度，不默认加速 —— 见下方 cruise 段
  if (touch.auto) updateCruise();
  if (gyro.enabled) input.steer = gyro.steer;
  input.handbrake = !!keys[' ']; // 手刹仅键盘保留，触屏走真实赛车路线不用漂移
}

// ★ 主循环每帧轮询：AUTO/陀螺仪这类“非事件状态”必须每帧重算，
//   否则要等下一次按键事件才生效
export function pollInput() { refresh(); }

const touch = { gas: false, brake: false, auto: false };

// ---- 定速巡航（AUTO，v2.17 重做）----
// 语义：AUTO = 保持当前速度，绝不默认加速。
//  · 开启瞬间若车静止 → 不给油，原地待命（等人工给过一次油再锁速）
//  · 巡航中点油门/刹车 = 人工接管（暂停巡航）；松开瞬间锁定当下速度为新目标
//  · 锁定后用 PI 控制补油：低于目标差得越多油门越大，高于目标直接滑行回目标。
//    积分项用于消除风阻 `speed*0.4` 与爬坡造成的稳态掉速
// 车速来源：window.game.player.speed（main.js 尾部调试钩子，m/s）
const cruise = { target: null, integral: 0, relock: false };
const CRUISE = { KP: 0.45, KI: 0.55, MAX_I: 2, MIN_LATCH: 0.5 }; // MIN_LATCH m/s 以下不锁速（静止/倒车不自动给油）

function playerSpeed() {
  const p = window.game && window.game.player;
  return p && typeof p.speed === 'number' ? p.speed : null;
}

function cruiseReset() { cruise.target = null; cruise.integral = 0; cruise.relock = false; }

// 帧间隔：refresh() 既被 pollInput 每帧调用，也被按键事件临时调用，用真实时钟差算 dt
let lastPoll = 0;
function pollDt() {
  const now = performance.now();
  if (!lastPoll) { lastPoll = now; return 0; }
  const dt = Math.min(0.1, (now - lastPoll) / 1000);
  lastPoll = now;
  return dt;
}

function updateCruise() {
  // 油门/刹车/手刹任一人工输入都算接管（否则拉手刹减速后巡航会把车再加速拉回目标）
  const manual = input.throttle || input.brake || input.handbrake;
  if (manual) { cruise.relock = true; return; } // 人工接管：保持人工油门/刹车值
  const spd = playerSpeed();
  if (spd == null) return;                      // 还没进游戏（window.game 未就绪）
  if (cruise.relock) {                          // 接管刚结束 → 锁定当下速度
    cruise.relock = false;
    cruise.target = spd > CRUISE.MIN_LATCH ? spd : null;
    cruise.integral = 0;
  }
  if (cruise.target == null) return;            // 无锁速目标（静止开启）→ 不给油
  const gap = cruise.target - spd;
  const dt = pollDt();
  if (Math.abs(gap) > 0.02) cruise.integral = Math.max(-CRUISE.MAX_I,
    Math.min(CRUISE.MAX_I, cruise.integral + gap * dt));
  input.throttle = Math.max(0, Math.min(1, CRUISE.KP * gap + CRUISE.KI * cruise.integral));
}

// ---- 陀螺仪转向 ----
// 手机横屏用 beta、竖屏用 gamma；开启瞬间记录回正位，带 5° 死区
const gyro = {
  enabled: false,
  supported: 'DeviceOrientationEvent' in window,
  steer: 0,
  offset: null,
};
export const gyroState = gyro;

function onOrient(e) {
  const type = (screen.orientation && screen.orientation.type) || '';
  let tilt;
  if (type.indexOf('landscape') === 0) {
    tilt = e.beta * (type === 'landscape-primary' ? 1 : -1);
  } else {
    tilt = e.gamma;
  }
  if (tilt == null) return;
  if (gyro.offset == null) gyro.offset = tilt;
  const d = tilt - gyro.offset;
  const dz = 5;                              // 死区 5°，握稳不乱晃
  gyro.steer = Math.abs(d) < dz
    ? 0
    : Math.max(-1, Math.min(1, (d - Math.sign(d) * dz) / 45)); // 倾斜 45° 才满舵，真实感
}

// 开/关陀螺仪；iOS 13+ 需要用户手势触发权限申请
export function toggleGyro() {
  if (!gyro.supported) {
    return Promise.resolve({ ok: false, on: false, msg: '此设备不支持陀螺仪' });
  }
  if (!window.isSecureContext) {
    return Promise.resolve({
      ok: false, on: false,
      msg: '陀螺仪需要 HTTPS：请用 https://10.10.1.202:8443 打开并接受证书警告',
    });
  }
  if (gyro.enabled) {
    gyro.enabled = false;
    gyro.steer = 0;
    window.removeEventListener('deviceorientation', onOrient);
    return Promise.resolve({ ok: true, on: false });
  }
  const DOE = window.DeviceOrientationEvent;
  const req = DOE.requestPermission ? DOE.requestPermission() : Promise.resolve('granted');
  return req.then((state) => {
    if (state !== 'granted') return { ok: false, on: false, msg: '陀螺仪权限被拒绝' };
    gyro.enabled = true;
    gyro.offset = null; // 开启后第一帧姿态 = 回正位
    gyro.steer = 0;
    window.addEventListener('deviceorientation', onOrient);
    return { ok: true, on: true };
  }).catch(() => ({ ok: false, on: false, msg: '陀螺仪权限申请失败' }));
}

function bindBtn(id, prop) {
  const el = document.getElementById(id);
  if (!el) return;
  const down = (e) => { e.preventDefault(); touch[prop] = true; el.classList.add('active'); refresh(); };
  const up = (e) => { e.preventDefault(); touch[prop] = false; el.classList.remove('active'); refresh(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}

export function initInput(onPause) {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'escape') onPause && onPause();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    refresh();
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; refresh(); });

  bindBtn('btn-gas', 'gas');
  bindBtn('btn-brake', 'brake');

  // AUTO 定速巡航开关（点按切换）；托管时油门键变暗降噪
  const autoEl = document.getElementById('btn-auto');
  if (autoEl) {
    const gasEl = document.getElementById('btn-gas');
    autoEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      touch.auto = !touch.auto;
      cruiseReset(); // 开/关都清空锁速状态：重开时若在行驶中会自动重锁当下速度
      autoEl.classList.toggle('active', touch.auto);
      if (gasEl) gasEl.classList.toggle('dimmed', touch.auto);
      refresh();
    });
    // 手机默认开启定速巡航（静止时待命，不给油）
    if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      touch.auto = true;
      autoEl.classList.add('active');
      if (gasEl) gasEl.classList.add('dimmed');
      refresh(); // 立即生效，不等第一次触摸
    }
  }

  // 手机默认自动开启陀螺仪（iOS 无手势授权会静默失败，
  // 此时保留菜单按钮由用户手动开启）
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    toggleGyro().then((r) => {
      if (r.on) {
        const gEl = document.getElementById('btn-gyro');
        if (gEl) gEl.textContent = '陀螺仪: 开';
      } else if (gyro.supported && window.isSecureContext) {
        // iOS 授权失败：菜单按钮闪烁提示手动开启
        const gEl = document.getElementById('btn-gyro');
        if (gEl) gEl.classList.add('attention');
      }
    });
  }

  // 阻止手机上页面滚动/双击缩放
  document.body.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
}
