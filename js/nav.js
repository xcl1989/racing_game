// Open-world routing: explicit at-grade movements, separate event circuits.
import * as THREE from 'three';
import { ROAD_JUNCTIONS } from './road-network.js';

export function buildNavGraph(world, track) {
  const chains = new Map();
  function add(id, samples, cost = 1, oneWay = false) {
    chains.set(id, { id, cost, oneWay, pts: samples.map((s, u) => ({ ...s.pos, w: s.w, u })) });
    return chains.get(id);
  }
  for (const r of world.roads) {
    const localStreet = r.id.startsWith('city') && r.samples[0].w < 10;
    add(r.id, r.samples, r.kind === 'dirt' ? 1.45 : localStreet ? 1.22 : 1,
      r.id === 'roundabout' || r.id === 'summitRing');
  }
  add('circuit', track.samples);
  const S = track.strip;
  add('strip', Array.from({ length: 77 }, (_, i) => ({ pos: {
    x: S.ax + (S.bx - S.ax) * i / 76, y: 0.02, z: S.az + (S.bz - S.az) * i / 76,
  }, w: S.width })));

  // Project onto each centerline and split the chain at the actual junction.
  const movements = [];
  const junctions = [...ROAD_JUNCTIONS, ...world.approachJunctions];
  const open = (id, x, z) => {
    const c = chains.get(id), list = c.pts;
    let best = Infinity, result;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d;
        result = t < 1e-7 ? a : t > 1 - 1e-7 ? b : { x: px, z: pz, y: a.y + (b.y - a.y) * t, w: a.w, u: a.u + t * (b.u - a.u) };
      }
    }
    if (!list.includes(result)) {
      list.push(result);
      list.sort((a, b) => a.u - b.u);
    }
    return result;
  };
  for (const [i, a] of world.cityStreets.entries()) {
    if (a.ax !== a.bx) continue;
    for (const [j, b] of world.cityStreets.entries()) {
      if (b.az !== b.bz || a.ax < b.ax || a.ax > b.bx || b.az < a.az || b.az > a.bz) continue;
      junctions.push([`city${i}`, `city${j}`, a.ax, b.az]);
    }
  }
  const rejected = [];
  for (const [a, b, x, z] of junctions) {
    const p = open(a, x, z), q = open(b, x, z);
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d > 12 || Math.abs(p.y - q.y) > 1.8 ||
        Array.from({ length: 9 }, (_, i) => i / 8).some(t => !world.onAnyRoad({
          x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t,
        }))) {
      rejected.push([a, b, x, z]);
      continue;
    }
    movements.push([p, q, false]);
  }
  for (const [i, lane] of world.northInterchange.lanes.entries()) {
    const { pts } = add(`ramp${i}`, lane.points.map(pos => ({ pos, w: 0 })), 1, true);
    const h = chains.get('highway').pts.find(p => p.u === lane.highwayIndex + (lane.entering ? 4 : -4));
    const cityEnd = lane.entering ? pts[0] : pts.at(-1);
    const city = open('city3', cityEnd.x, cityEnd.z);
    if (lane.entering) movements.push([city, cityEnd, true], [pts.at(-1), h, true]);
    else movements.push([h, pts[0], true], [cityEnd, city, true]);
  }
  // Densify long street sections even between intersections for reliable snapping.
  for (const c of chains.values()) {
    if (!c.id.startsWith('city')) continue;
    const old = c.pts, pts = [old[0]];
    for (let i = 1; i < old.length; i++) {
      const a = old[i - 1], b = old[i], n = Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / 8);
      for (let j = 1; j < n; j++) {
        const t = j / n;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t, w: a.w });
      }
      pts.push(b);
    }
    c.pts = pts;
  }

  const px = [], py = [], pz = [], pw = [], roadOf = [], adj = [];
  function link(a, b, oneWay = false, cost = 1) {
    const w = Math.max(0.001, Math.hypot(a.x - b.x, a.z - b.z) * cost);
    adj[a.node].push({ to: b.node, w });
    if (!oneWay) adj[b.node].push({ to: a.node, w });
  }
  for (const c of chains.values()) {
    for (const p of c.pts) {
      p.node = px.length;
      px.push(p.x); py.push(p.y); pz.push(p.z); pw.push(p.w); roadOf.push(c.id); adj.push([]);
    }
    for (let i = 1; i < c.pts.length; i++) link(c.pts[i - 1], c.pts[i], c.oneWay, c.cost);
    const first = c.pts[0], last = c.pts.at(-1);
    if (c.pts.length > 2 && Math.hypot(first.x - last.x, first.z - last.z) < 0.15) link(last, first, c.oneWay);
  }
  for (const [a, b, oneWay] of movements) link(a, b, oneWay);
  const size = px.length;
  function nearestNode(x, z, maxR = 40) {
    let best = -1, bd = maxR * maxR;
    for (let i = 0; i < size; i++) {
      const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  return { px, py, pz, pw, adj, roadOf, nearestNode, size, rejected, junctions };
}

// ---- A* 最短路：返回世界坐标点数组（不含起终点精确位置，调用方自行补）----
export function findRoute(graph, sx, sz, gx, gz) {
  const s = graph.nearestNode(sx, sz);
  const g = graph.nearestNode(gx, gz);
  if (s < 0 || g < 0) return null;
  if (s === g) return { pts: [{ x: graph.px[g], y: graph.py[g], z: graph.pz[g] }], hops: 0 };

  const n = graph.size;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const h = (i) => Math.hypot(graph.px[i] - graph.px[g], graph.pz[i] - graph.pz[g]);
  gScore[s] = 0;
  // 小顶堆（[f, node]）
  const heap = [];
  const push = (f, v) => {
    heap.push([f, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  push(h(s), s);
  while (heap.length) {
    const [, cur] = pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    for (const e of graph.adj[cur]) {
      if (closed[e.to]) continue;
      const ng = gScore[cur] + e.w;
      if (ng < gScore[e.to]) {
        gScore[e.to] = ng;
        came[e.to] = cur;
        push(ng + h(e.to), e.to);
      }
    }
  }
  if (came[g] < 0 && g !== s) return null; // 不可达
  const out = [];
  for (let v = g; v !== -1; v = came[v]) out.push(v);
  out.reverse();
  return {
    // v2.27 pts 附带节点路宽 w（引导线靠右车道偏移消费）
    pts: out.map((v) => ({ x: graph.px[v], y: graph.py[v], z: graph.pz[v], w: graph.pw[v] })),
    hops: 0,
  };
}

// ---------- 3D 流光引导线 ----------
function makeChevronTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const x = cv.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(190,245,255,0.95)';
  x.lineWidth = 13;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  // 双箭头朝 v+ 方向（路径前进向）
  for (const y0 of [92, 44]) {
    x.beginPath();
    x.moveTo(30, y0 + 22);
    x.lineTo(64, y0 - 22);
    x.lineTo(98, y0 + 22);
    x.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class NavGuide {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.chevronTex = makeChevronTexture();
    this.routeMesh = null;
    this.marker = null; // { ring, beam }
    this.t = 0;
  }

  // pts: Vector3[]（首=车当前位置，尾=目的地）
  setRoute(pts, destination = pts?.at(-1)) {
    this.clear();
    if (!pts?.length || !destination) return;
    // 稠密化：节点间距 ≤4m，y 线性插值 + 抬升防 Z-fighting
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 0.01) continue;
      const n = Math.max(1, Math.ceil(d / 4));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const v = new THREE.Vector3(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t + 0.15,
          a.z + (b.z - a.z) * t
        );
        v.w = Math.min(a.w ?? 10, b.w ?? 10); // 节点路宽随段传递（v2.27 车道偏移消费）
        dense.push(v);
      }
    }
    dense.push(pts[pts.length - 1].clone().setY(pts[pts.length - 1].y + 0.15));
    dense[dense.length - 1].w = pts[pts.length - 1].w ?? 10;

    // 带状网格：宽 1.8m，v 沿路径累计长度（chevron 每 6m 一个）
    // v2.27 靠右车道偏移：引导线不再压路中线——按所在路宽向行驶方向右侧偏
    //   off = clamp(w/4, 0.9, 3.3)：双向路 = 右车道中心（w/4），宽路封顶 3.3，
    //   窄路（野径 4.5m）只轻微右偏不蹭缘；行驶方向右侧向量 = (−tz, tx)（= ribbon side 的反向）
    //   路宽过渡处（大道→巷道）5 点滑动平均防跳变
    const offs = [];
    for (let i = 0; i < dense.length; i++) {
      const w = dense[i].w;
      offs.push(w === 0 ? 0 : Math.min(3.3, Math.max(0.9, w / 4)));
    }
    for (let i = 0; i < offs.length; i++) { // 滑动平均（边界 clamp）
      let sum = 0, cnt = 0;
      for (let k = -3; k <= 3; k++) {
        const j = Math.min(dense.length - 1, Math.max(0, i + k));
        sum += offs[j]; cnt++;
      }
      offs[i] = sum / cnt;
    }

    const verts = [], uvs = [], idx = [];
    let v = 0;
    for (let i = 0; i < dense.length; i++) {
      const p = dense[i];
      const q = dense[Math.min(i + 1, dense.length - 1)];
      const r = dense[Math.max(i - 1, 0)];
      let tx = q.x - r.x, tz = q.z - r.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const sx = tz, sz = -tx;              // 左侧向量（世界侧向）
      const off = offs[i];
      const cx = p.x - sx * off, cz = p.z - sz * off; // 右车道中心 = 中线 − 左侧向量×off
      verts.push(cx + sx * 0.9, p.y, cz + sz * 0.9, cx - sx * 0.9, p.y, cz - sz * 0.9);
      if (i > 0) v += dense[i].distanceTo(dense[i - 1]) / 6;
      uvs.push(0, v, 1, v);
      if (i < dense.length - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    this.chevronTex.repeat.set(1, 1); // v 坐标已按 6m 周期写入，repeat 保持 1
    const mat = new THREE.MeshBasicMaterial({
      map: this.chevronTex, color: 0x8fe8ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.routeMesh = new THREE.Mesh(geo, mat);
    this.routeMesh.frustumCulled = false; // 长路径包围盒跨全图，防整体被裁
    this.group.add(this.routeMesh);

    // 目的地信标：光柱 + 脉冲光环
    const end = destination;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.0, 1.4, 60, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2ee6ff, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    beam.position.set(end.x, end.y + 30, end.z);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.16, 8, 26),
      new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(end.x, end.y + 0.7, end.z);
    this.group.add(beam, ring);
    this.marker = { beam, ring };
    this.group.visible = true;
  }

  clear() {
    if (this.routeMesh) {
      this.routeMesh.geometry.dispose();
      this.routeMesh.material.dispose();
      this.group.remove(this.routeMesh);
      this.routeMesh = null;
    }
    if (this.marker) {
      this.marker.beam.geometry.dispose(); this.marker.beam.material.dispose();
      this.marker.ring.geometry.dispose(); this.marker.ring.material.dispose();
      this.group.remove(this.marker.beam, this.marker.ring);
      this.marker = null;
    }
    this.group.visible = false;
  }

  update(dt) {
    if (!this.group.visible) return;
    this.t += dt;
    this.chevronTex.offset.y -= dt * 0.7; // 箭头向目的地流动
    if (this.marker) {
      const k = 1 + Math.sin(this.t * 4) * 0.18;
      this.marker.ring.scale.set(k, k, 1);
    }
  }
}
