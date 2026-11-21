import { Color } from 'three';
import { terrainTint } from './world-surface-finish.js';
import { LAKE, FOOTHILL_LAKE, RIVER } from './world-guide.js';

const S = 1024;
const TAU = Math.PI * 2;
// [minimap color, close width, atlas color, atlas width, optional dash]
const STYLES = {
  dirt: ['#bca487', 1.55, '#92866c', 1.85, [3.6, 3]],
  local: ['#97abb0', 1.65, '#c4c9b6', 2.65],
  circuit: ['#d4b59f', 2.1, '#c1a797', 3.5],
  arterial: ['#c9d2ce', 2.5, '#ebe4cb', 3.6],
  highway: ['#e2c17d', 3.6, '#e4bb74', 5.25],
  ramps: ['#e2c17d', 1.8, '#d3b079', 2.4],
  bridge: ['#ebd5b1', 2.2, '#e4d0a5', 3.1],
};
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function circle(x, y, r) {
  const path = new Path2D();
  path.arc(x, y, r, 0, TAU);
  return path;
}
function paths(lines) {
  const path = new Path2D();
  for (const line of lines) line.forEach(([x, z], i) => i ? path.lineTo(x, z) : path.moveTo(x, z));
  return path;
}
function marker(ctx, x, y, color, size, diamond = false) {
  ctx.beginPath();
  if (diamond) {
    ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y);
    ctx.closePath();
  } else ctx.arc(x, y, size, 0, TAU);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 1.4; ctx.strokeStyle = '#0a1b24'; ctx.stroke();
}
function arrow(ctx, x, y, angle, size, color, stroke = '#0b1b23') {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle); ctx.scale(size, size);
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(6.1, 6.5); ctx.lineTo(0, 3.6); ctx.lineTo(-6.1, 6.5);
  ctx.closePath();
  ctx.strokeStyle = stroke; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

function mapTerrain(mountain) {
  const river = new Path2D();
  const { x, halfWidth: w, halfLength: l } = RIVER;
  river.moveTo(x, -l);
  river.quadraticCurveTo(x + w, -l + 90, x + w, -l + 160);
  river.lineTo(x + w, l - 160); river.quadraticCurveTo(x + w, l - 90, x, l);
  river.quadraticCurveTo(x - w, l - 90, x - w, l - 160);
  river.lineTo(x - w, -l + 160); river.quadraticCurveTo(x - w, -l + 90, x, -l);
  river.closePath();
  return {
    city: new Path2D('M 791 72 H 1309 V 628 H 791 Z'),
    water: [river, ...[LAKE, FOOTHILL_LAKE].map(lake => circle(lake.x, lake.z, lake.r))],
    contours: [480, 408, 336, 265, 190, 113, 55].map(r => circle(mountain.x, mountain.z, r)),
  };
}

export class MapView {
  constructor(world, track, mini, big) {
    this.mini = mini; this.big = big;
    this.mm = mini.getContext('2d', { alpha: false });
    this.bm = big.getContext('2d', { alpha: false });
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = S;
    this.guide = world.guide.filter(region => region.label);
    this.terrain = mapTerrain(world.MT);
    const strip = track.strip;
    const roads = { ...world.mapRoads, circuit: [track.samples.map(({ pos }) => [pos.x, pos.z]),
      [[strip.ax, strip.az], [strip.bx, strip.bz]]] };
    this.roads = Object.fromEntries(Object.entries(roads).map(([id, lines]) => [id, paths(lines)]));
    this.events = [];
    this.lastMini = -Infinity;
    this.miniState = null;
    this.routePaths = new WeakMap();
    this.rect = [-2000, 2000, -2100, 2000];
    const [minX, maxX, minZ, maxZ] = this.rect;
    this.cx = (minX + maxX) * .5; this.cz = (minZ + maxZ) * .5;
    this.scale = (S - 80) / Math.max(maxX - minX, maxZ - minZ);
    this.buildBase(world);
  }

  // Match the in-game camera: facing +Z, world +X is screen-left.
  project(x, z) { return [S / 2 - (x - this.cx) * this.scale, S / 2 - (z - this.cz) * this.scale]; }
  unproject(x, y) { return [this.cx - (x - S / 2) / this.scale, this.cz - (y - S / 2) / this.scale]; }

  terrainAndRoads(ctx, scale, full, far = false) {
    const { terrain, roads } = this;
    if (!full) {
      ctx.fillStyle = '#253438'; ctx.fill(terrain.city);
      ctx.strokeStyle = '#476057'; ctx.lineWidth = .75 / scale;
      for (const [i, contour] of terrain.contours.entries()) {
        ctx.fillStyle = i % 2 ? '#263e38' : '#213832';
        ctx.fill(contour); ctx.stroke(contour);
      }
    }
    for (const water of terrain.water) {
      ctx.fillStyle = full ? '#254d59' : '#143d50'; ctx.fill(water);
      ctx.strokeStyle = full ? '#618384' : '#397480'; ctx.lineWidth = (full ? 1.35 : .75) / scale; ctx.stroke(water);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [id, [miniColor, miniWidth, bigColor, bigWidth, dash]] of Object.entries(STYLES)) {
      const w = full ? bigWidth : miniWidth * (far ? .72 : 1);
      if (!dash) {
        ctx.strokeStyle = full ? '#29332d' : '#101c24'; ctx.lineWidth = (w + (full ? 1.5 : 1.25)) / scale;
        ctx.stroke(roads[id]);
      } else ctx.setLineDash(dash.map(n => n * (full ? 1.9 : 1) / scale));
      ctx.strokeStyle = full ? bigColor : miniColor; ctx.lineWidth = w / scale; ctx.stroke(roads[id]);
      if (dash) ctx.setLineDash([]);
    }
  }

  drawRelief(ctx, sampleTerrain) {
    // Bake once from the drivable heightfield. The broad color variation is decorative only.
    const n = 256, step = S / n / this.scale;
    const tile = document.createElement('canvas');
    tile.width = tile.height = n;
    const tc = tile.getContext('2d'), image = tc.createImageData(n, n);
    const tint = new Color();
    for (let row = 0, i = 0; row < n; row++) for (let col = 0; col < n; col++, i += 4) {
      const [x, z] = this.unproject((col + .5) * S / n, (row + .5) * S / n);
      const h = sampleTerrain(x, z);
      const dx = sampleTerrain(x + step, z) - sampleTerrain(x - step, z);
      const dz = sampleTerrain(x, z + step) - sampleTerrain(x, z - step);
      const relief = clamp(-(dx * .7 + dz) * 3.1, -24, 23);
      const grain = Math.sin(x * .062 + Math.sin(z * .085)) * Math.sin(z * .067) * 1.3;
      const fields = Math.sin(x * .003 + Math.cos(z * .002)) * 3 + Math.cos(z * .0038 - x * .002) * 4;
      const light = 6 * Math.max(0, h) / 72 + relief + fields + grain;
      terrainTint(x, z, h, Math.hypot(dx, dz) / (step * 2), tint);
      image.data[i] = 56 + light + (tint.r - .88) * 27;
      image.data[i+1] = 69 + light + (tint.g - .87) * 32;
      image.data[i+2] = 56 + light * .7 + (tint.b - .77) * 34;
      image.data[i+3] = 255;
    }
    tc.putImageData(image, 0, 0);
    ctx.drawImage(tile, 0, 0, S, S);
  }

  buildBase(world) {
    const ctx = this.base.getContext('2d');
    this.drawRelief(ctx, world.groundSampler);
    ctx.save();
    ctx.translate(S / 2, S / 2); ctx.scale(-this.scale, -this.scale); ctx.translate(-this.cx, -this.cz);
    ctx.fillStyle = '#a9a89b73';
    for (const { x, z, hw, hd } of world.bldColliders) ctx.fillRect(x - hw, z - hd, 2 * hw, 2 * hd);
    this.terrainAndRoads(ctx, this.scale, true);
    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 32px "Songti SC", "Noto Serif CJK SC", serif';
    ctx.lineJoin = 'round'; ctx.strokeStyle = '#24352b'; ctx.lineWidth = 4.5;
    ctx.fillStyle = '#f0eedb';
    for (const region of this.guide) {
      const [x, y] = this.project(...region.label);
      ctx.strokeText(region.name, x, y);
      ctx.fillText(region.name, x, y);
    }
    arrow(ctx, S - 42, 61, 0, 1.45, '#d7eee7');
    ctx.font = 'bold 18px monospace'; ctx.fillStyle = '#e1f1ea'; ctx.fillText('N', S - 42, 34);
    const bar = 500 * this.scale;
    ctx.strokeStyle = '#accac0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(S - 31 - bar, S - 32); ctx.lineTo(S - 31 - bar, S - 24);
    ctx.lineTo(S - 31, S - 24); ctx.lineTo(S - 31, S - 32); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText('500 m', S - 31, S - 40);
  }

  routePath(route) {
    if (!route) return null;
    let path = this.routePaths.get(route);
    if (!path) {
      const pts = route.pts || route.samples.map(s => s.pos);
      path = paths([pts.map(p => [p.x, p.z])]);
      this.routePaths.set(route, path);
    }
    return path;
  }

  route(ctx, route, scale, width, color) {
    const path = this.routePath(route);
    if (!path) return;
    if (route.fallback) ctx.setLineDash([4 / scale, 4 / scale]);
    ctx.strokeStyle = '#10222a'; ctx.lineWidth = (width + 2.5) / scale; ctx.stroke(path);
    ctx.strokeStyle = color; ctx.lineWidth = width / scale; ctx.stroke(path);
    ctx.setLineDash([]);
  }

  drawMini(game, now = performance.now()) {
    // Update the canvas at 30 Hz; smooth the heading in time, not by a fixed per-frame amount.
    const elapsed = now - this.lastMini;
    if (elapsed < 31) return;
    this.lastMini = now;
    const size = this.mini.clientWidth;
    if (!size) return;
    const px = Math.round(size * Math.min(devicePixelRatio || 1, 2));
    if (this.mini.width !== px) this.mini.width = this.mini.height = px;
    const ctx = this.mm;
    ctx.setTransform(px / size, 0, 0, px / size, 0, 0);
    ctx.fillStyle = '#1a2e2d'; ctx.fillRect(0, 0, size, size);
    const { player, mode, nav, sprint } = game;
    const zoom = game.mmZooms[game.mmZoomIdx];
    const overview = zoom.range === 0;
    const targetRange = zoom.range * (zoom.auto ? 1 + clamp((Math.abs(player.speed) - 10) / 40, 0, 1) * .95 : 1);
    const { x, z } = player.pos;
    let state = this.miniState;
    if (!state || Math.hypot(x - state.x, z - state.z) > 38 || elapsed > 300) {
      state = this.miniState = { x, z, yaw: player.yaw, range: targetRange, index: game.mmZoomIdx };
    }
    const k = 1 - Math.exp(-elapsed / 82);
    state.yaw += Math.atan2(Math.sin(player.yaw - state.yaw), Math.cos(player.yaw - state.yaw)) * k;
    state.range = state.index === game.mmZoomIdx ? state.range + (targetRange - state.range) * k : targetRange;
    state.index = game.mmZoomIdx; state.x = x; state.z = z;
    const northScale = size / S;
    const viewScale = overview ? this.scale * northScale : size / state.range;
    const cx = size / 2, cy = overview ? cx : size * (player.speed < -1 ? .55 : .65);
    const a = state.yaw, cos = Math.cos(a), sin = Math.sin(a);
    const project = overview ? (wx, wz) => this.project(wx, wz).map(n => n * northScale) : (wx, wz) => {
      const dx = wx - x, dz = wz - z;
      return [cx + (-dx * cos + dz * sin) * viewScale, cy + (-dx * sin - dz * cos) * viewScale];
    };
    ctx.save();
    if (overview) {
      ctx.translate(cx, cy); ctx.scale(-viewScale, -viewScale); ctx.translate(-this.cx, -this.cz);
    } else {
      ctx.translate(cx, cy); ctx.scale(viewScale, viewScale); ctx.rotate(Math.PI + a); ctx.translate(-x, -z);
    }
    this.terrainAndRoads(ctx, viewScale, false, overview || state.range > 600);
    const activeNav = mode === 'free' && nav;
    this.route(ctx, activeNav || ((mode === 'sprint' || mode === 'offroad') && sprint?.R), viewScale, overview ? 2.5 : 3.35,
      activeNav ? (nav.fallback ? '#a9bdc6' : '#49edff') : mode === 'offroad' ? '#b0ed7a' : '#ff96cd');
    ctx.restore();
    const dot = (wx, wz, c, r, diamond) => {
      const [mx, my] = project(wx, wz);
      if (mx < 6 || mx > size - 6 || my < 6 || my > size - 7) return;
      marker(ctx, mx, my, c, r, diamond);
    };
    if (mode === 'free' && !overview && state.range <= 400) {
      for (const t of game.traffic) if (t.group.visible) dot(t.pos.x, t.pos.z, '#f2efe2', 1.75);
    }
    if (mode !== 'free' || (!overview && state.range <= 400)) for (const ai of game.ais) {
      if (ai.group.visible) dot(ai.pos.x, ai.pos.z, `#${ai.color.toString(16).padStart(6, '0')}`, 2.7);
    }
    if (mode === 'free') for (const e of this.events) {
      if (activeNav && Math.hypot(e.pos.x - nav.dest.x, e.pos.z - nav.dest.z) < 12) continue;
      if (!activeNav || overview) dot(e.pos.x, e.pos.z, e.mapColor, overview ? 2.6 : 3.2, true);
    }
    const raceGates = sprint?.cps ?? ((mode === 'race' || mode === 'time') ? game.track.raceGates : null);
    const next = raceGates?.[game.nextGate];
    if (next) dot(next.pos.x, next.pos.z, '#ffda7e', 4, true);
    if (game.ringGroup.visible) for (const r of game.rings) {
      if (!r.userData.done) dot(r.position.x, r.position.z, '#47e2f2', 2.4);
    }
    const [mx, my] = project(x, z);
    if (activeNav) {
      const [dx, dy] = project(nav.dest.x, nav.dest.z);
      if (dx >= 9 && dx <= size - 9 && dy >= 9 && dy <= size - 19) marker(ctx, dx, dy, '#49edff', 5, true);
      else {
        const vx = dx - mx, vy = dy - my;
        const t = Math.min((vx < 0 ? mx - 12 : size - 12 - mx) / Math.max(.01, Math.abs(vx)),
          (vy < 0 ? my - 12 : size - 22 - my) / Math.max(.01, Math.abs(vy)));
        if (t > 0) arrow(ctx, mx + vx * t, my + vy * t, Math.atan2(vx, -vy), .75, '#49edff');
      }
    }
    arrow(ctx, clamp(mx, 9, size - 9), clamp(my, 10, size - 12), overview ? -player.yaw : a - player.yaw,
      size < 120 ? .85 : 1, '#fff6dd');
    const nx = overview ? size - 13 : cx + sin * (cx - 12);
    const ny = overview ? 13 : cx - cos * (cx - 12);
    ctx.fillStyle = '#10222ded'; ctx.fill(circle(nx, ny, 7.4));
    ctx.fillStyle = '#eefaf1'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + .4);
    const label = zoom.auto ? `自动 · ${Math.round(state.range / 50) * 50} m` : zoom.label;
    ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = '#10222ded'; ctx.fillRect(5, size - 19, ctx.measureText(label).width + 11, 15);
    ctx.fillStyle = '#d8eee9'; ctx.fillText(label, 10, size - 11);
  }

  drawBig(game) {
    const ctx = this.bm;
    ctx.drawImage(this.base, 0, 0);
    const { nav, bigPick, player } = game;
    if (nav) {
      ctx.save();
      ctx.translate(S / 2, S / 2); ctx.scale(-this.scale, -this.scale); ctx.translate(-this.cx, -this.cz);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      this.route(ctx, nav, this.scale, 5, nav.fallback ? '#a9bdc6' : '#49edff');
      ctx.restore();
      marker(ctx, ...this.project(nav.dest.x, nav.dest.z), '#49edff', 9, true);
    }
    for (const region of this.guide) if (region.target) marker(ctx,
      ...this.project(region.target.x, region.target.z), '#d7e5d2', 3.4);
    for (const e of this.events) marker(ctx, ...this.project(e.pos.x, e.pos.z), '#e4b588', 5.8, true);
    if (bigPick) {
      const [x, y] = this.project(bigPick.x, bigPick.z);
      ctx.strokeStyle = '#ffcf80'; ctx.lineWidth = 3; ctx.stroke(circle(x, y, 14));
      marker(ctx, x, y, '#ffcf80', 4);
    }
    const [x, y] = this.project(player.pos.x, player.pos.z);
    arrow(ctx, clamp(x, 15, S - 15), clamp(y, 15, S - 15), -player.yaw, 1.65, '#fff6dd');
  }
}
