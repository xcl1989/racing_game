// nav.js — 开放世界导航（v2.18）：路网图构建 + A* 寻路 + 3D 流光引导线
// 数据源：world 各 ribbon 道路的 samples（约 8m 一点）+ cityStreets 直线段 + track 主环道
// 连接策略：绝大多数路口两端精确搭接（阈值 8m 自动连边全覆盖）；只有湖畔环岛群
// 接入间隙 6~15m、环岛采样间隔 ~10.5m，自动阈值够不着 → JUNCTIONS 手工登记吸附。
// 主环道/直线赛道与世界路网不物理相连（比赛围场设计），作为孤链入图：环内导航可用，
// 跨网寻路不可达时 findRoute 返回 null，调用方走直线引导兜底。
import * as THREE from 'three';

const JUNCTIONS = [
  { x: 820, z: -402, r: 22 }, // 湖滨路南端 → 环岛
  { x: 846, z: -420, r: 22 }, // 湖东野径东端 → 环岛
  { x: 794, z: -420, r: 22 }, // 湖东野径西端 → 环岛
  { x: 800, z: -392, r: 22 }, // 湖西环路东端 → 环岛
];
const AUTO_LINK = 8;  // 不同道路节点自动连边阈值（m）
const SNAP_R = 40;    // 起点/目的地吸附最近节点半径（活动光柱在路缘外 12m）

export function buildNavGraph(world, track) {
  const chains = [];
  const addPts = (roadId, pts, cost = 1) => { if (pts.length) chains.push({ roadId, cost, pts }); };
  let id = 0;
  // v2.27 road() 从 samples.w 取路宽（ribbon/track 均已附带）
  const road = (samples, cost = 1) => {
    addPts(id, samples.map((s) => ({ x: s.pos.x, y: s.pos.y, z: s.pos.z, w: s.w })), cost);
    id++;
  };
  road(world.highway.samples);
  road(world.eastConn.samples);
  road(world.southConn.samples);
  road(world.lakeRoad.samples);
  road(world.roundabout.samples);
  road(world.national.samples);
  road(world.mountainRoad.samples);
  road(world.summitRing.samples);
  road(world.trail.samples, 1.3);    // 土路成本略高，寻路优先沥青
  road(world.westLake.samples);
  road(world.swLink.samples);
  road(world.country.samples, 1.3);
  // ⚠️ world.cityRoute 是隐藏 NPC 环线（无实体路面），与城市街道重复，不入图
  // Every street has its own chain. Put a node exactly at each perpendicular crossing.
  for (const st of world.cityStreets) {
    const dx = st.bx - st.ax, dz = st.bz - st.az;
    const n = Math.max(1, Math.round(Math.hypot(dx, dz) / 10));
    const cuts = Array.from({ length: n + 1 }, (_, i) => i / n);
    for (const other of world.cityStreets) {
      if ((dx === 0) === (other.bx === other.ax)) continue;
      const t = dx === 0 ? (other.az - st.az) / dz : (other.ax - st.ax) / dx;
      const cross = dx === 0 ? st.ax : st.az;
      const a = dx === 0 ? other.ax : other.az;
      const b = dx === 0 ? other.bx : other.bz;
      if (t > 0 && t < 1 && cross >= Math.min(a,b) && cross <= Math.max(a,b)) cuts.push(t);
    }
    cuts.sort((a,b) => a-b);
    const pts = cuts.filter((t,i) => !i || t-cuts[i-1] > 1e-6)
      .map((t) => ({ x:st.ax+dx*t, y:0.02, z:st.az+dz*t, w:st.width }));
    addPts(id++, pts);
  }
  const rampLinks = world.northInterchange.lanes.map((lane) => {
    const roadId = id++;
    addPts(roadId, lane.points.map(({ x, y, z }) => ({ x, y, z, w: 0 })), 1);
    return { ...lane, roadId };
  });
  const isRamp = new Set(rampLinks.map(({ roadId }) => roadId));
  // 主赛道环道（1m 采样）+ 直线加速赛道
  road(track.samples, 1);
  {
    const S = track.strip;
    const len = Math.hypot(S.bx - S.ax, S.bz - S.az);
    const n = Math.max(1, Math.round(len / 10));
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push({ x: S.ax + (S.bx - S.ax) * t, y: 0.02, z: S.az + (S.bz - S.az) * t, w: S.width });
    }
    addPts(id++, pts);
  }

  // ---- 摊平成节点 + 链内边 ----
  const px = [], py = [], pz = [], pw = [], roadOf = []; // pw: 节点所在路宽（v2.27 引导线车道偏移）
  const adj = []; // adj[i] = [{to, w}, ...]
  const edgeSet = new Set(); // 去重："min_max"
  const link = (a, b, w, oneWay = false) => {
    const key = oneWay ? `${a}>${b}` : a < b ? `${a}_${b}` : `${b}_${a}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    adj[a].push({ to: b, w });
    if (!oneWay) adj[b].push({ to: a, w });
  };
  const bases = [];
  for (const ch of chains) {
    const base = bases[ch.roadId] = px.length;
    for (const p of ch.pts) {
      px.push(p.x); py.push(p.y); pz.push(p.z); pw.push(p.w ?? 10); roadOf.push(ch.roadId);
      adj.push([]);
    }
    for (let k = 0; k < ch.pts.length - 1; k++) {
      const d = Math.hypot(px[base + k + 1] - px[base + k], pz[base + k + 1] - pz[base + k]);
      if (d > 0.01) link(base + k, base + k + 1, d * ch.cost, isRamp.has(ch.roadId));
    }
    // 闭合环路：samples 的 t=0 与 t=1 位置重合但链上无边 → 环路会退化成"一条线"绕远
    const n0 = base, n1 = base + ch.pts.length - 1;
    if (ch.pts.length > 2 && Math.hypot(px[n1] - px[n0], pz[n1] - pz[n0]) < 1.5) {
      link(n0, n1, 0.01);
    }
  }

  // ---- 跨路连边：① 阈值自动连接（网格哈希加速）② 手工登记路口 ----
  const CELL = 8;
  const grid = new Map();
  const key2 = (cx, cz) => `${cx},${cz}`;
  px.forEach((x, i) => {
    const k = key2(Math.floor(x / CELL), Math.floor(pz[i] / CELL));
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  const nodeCount = px.length;
  for (let i = 0; i < nodeCount; i++) {
    const cx = Math.floor(px[i] / CELL), cz = Math.floor(pz[i] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(key2(cx + dx, cz + dz));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i || roadOf[i] === roadOf[j] || isRamp.has(roadOf[i]) || isRamp.has(roadOf[j])) continue;
        const d = Math.hypot(px[i] - px[j], pz[i] - pz[j]);
        if (d < AUTO_LINK) link(i, j, d);
      }
    }
  }
  // Connect only the legal ramp terminals; proximity would jump between the
  // parallel lanes and skip the tapers. Carry the lane change forward by 32 m.
  for (const { points, roadId, highwayIndex, entering } of rampLinks) {
    const head = bases[roadId], tail = head + points.length - 1;
    const h = bases[0] + highwayIndex + (entering ? 4 : -4);
    const end = entering ? head : tail;
    const d = (a, b) => Math.hypot(px[a] - px[b], pz[a] - pz[b]);
    link(entering ? tail : h, entering ? h : head, d(h, entering ? tail : head), true);
    // The street junction has several coincident chain nodes. Pick the
    // nearest one outside the ramp; all crossing streets remain connected.
    let city = -1;
    for (let i = 0; i < nodeCount; i++) {
      if (isRamp.has(roadOf[i])) continue;
      if (d(i, end) < (city < 0 ? AUTO_LINK : d(city, end))) city = i;
    }
    if (city !== -1) link(entering ? city : end, entering ? end : city, d(city, end), true);
  }
  for (const jn of JUNCTIONS) {
    const found = new Map(); // roadId → 最近节点
    for (let i = 0; i < nodeCount; i++) {
      if (isRamp.has(roadOf[i])) continue;
      const d = Math.hypot(px[i] - jn.x, pz[i] - jn.z);
      if (d > jn.r) continue;
      const cur = found.get(roadOf[i]);
      if (!cur || d < cur.d) found.set(roadOf[i], { i, d });
    }
    const nodes = [...found.values()];
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const d = Math.hypot(px[nodes[a].i] - px[nodes[b].i], pz[nodes[a].i] - pz[nodes[b].i]);
      link(nodes[a].i, nodes[b].i, Math.max(4, d)); // 交汇点跨接给个保底权值
    }
  }

  // ---- 缝合孤立路岛（v2.18.2）----
  // 主环道/直线赛道与世界路网不物理相连（比赛围场设计）——给分量间最短节点对
  // 加"越野捷径"边（权重 ×1.8 优先走正常路网），跨岛寻路 95% 沿路走、只 hops 一小段，
  // 不再整条直线穿野。虚边标记 virt=true，寻路结果带上越野段数供 HUD 提示。
  function stitchIslands() {
    for (let round = 0; round < 8; round++) {
      // 连通分量染色
      const comp = new Int32Array(nodeCount).fill(-1);
      let nc = 0;
      for (let i = 0; i < nodeCount; i++) {
        if (comp[i] !== -1) continue;
        const q = [i]; comp[i] = nc;
        while (q.length) {
          const c = q.pop();
          for (const e of adj[c]) if (comp[e.to] === -1) { comp[e.to] = nc; q.push(e.to); }
        }
        nc++;
      }
      if (nc <= 1) break;
      // 全局最近跨分量节点对（节点 ~4300，一轮 O(n²) ≈ 9M 次，构建期一次性可接受）
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < nodeCount; i++) {
        for (let j = i + 1; j < nodeCount; j++) {
          if (comp[i] === comp[j]) continue;
          const d = (px[i] - px[j]) ** 2 + (pz[i] - pz[j]) ** 2;
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      if (bi < 0) break;
      link(bi, bj, Math.sqrt(bd) * 1.8);
      const ea = adj[bi].find((e) => e.to === bj);
      const eb = adj[bj].find((e) => e.to === bi);
      if (ea) ea.virt = true;
      if (eb) eb.virt = true;
    }
  }
  stitchIslands();

  return { px, py, pz, pw, adj, nearestNode, size: nodeCount };

  function nearestNode(x, z, maxR = SNAP_R) {
    let best = -1, bd = maxR * maxR;
    for (let i = 0; i < nodeCount; i++) {
      const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}

// ---- A* 最短路：返回世界坐标点数组（不含起终点精确位置，调用方自行补）----
export function findRoute(graph, sx, sz, gx, gz) {
  const s = graph.nearestNode(sx, sz);
  const g = graph.nearestNode(gx, gz);
  if (s < 0 || g < 0) return null;
  if (s === g) return { pts: [{ x: graph.px[g], y: graph.py[g], z: graph.pz[g] }], hops: 0 };

  const n = graph.size;
  const gScore = new Float32Array(n).fill(Infinity);
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
        push(ng + h(e.to) * 1.01, e.to);
      }
    }
  }
  if (came[g] < 0 && g !== s) return null; // 不可达
  const out = [];
  for (let v = g; v !== -1; v = came[v]) out.push(v);
  out.reverse();
  // 数越野捷径段（ stitching 虚边）
  let hops = 0;
  for (let k = 0; k + 1 < out.length; k++) {
    const e = graph.adj[out[k]].find((e) => e.to === out[k + 1]);
    if (e && e.virt) hops++;
  }
  return {
    // v2.27 pts 附带节点路宽 w（引导线靠右车道偏移消费）
    pts: out.map((v) => ({ x: graph.px[v], y: graph.py[v], z: graph.pz[v], w: graph.pw[v] })),
    hops,
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
  setRoute(pts) {
    this.clear();
    if (!pts || pts.length < 2) return;
    // 稠密化：节点间距 ≤4m，y 线性插值 + 抬升防 Z-fighting
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(d / 4));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const v = new THREE.Vector3(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t + 0.15,
          a.z + (b.z - a.z) * t
        );
        v.w = a.w ?? 10; // 节点路宽随段传递（v2.27 车道偏移消费）
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
    const end = pts[pts.length - 1];
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.0, 1.4, 60, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2ee6ff, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    beam.position.set(end.x, 30, end.z);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.16, 8, 26),
      new THREE.MeshBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(end.x, 0.7, end.z);
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
