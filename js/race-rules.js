// Event geometry and rules shared by the HUD, timing and opponent strategy.
export const RACE_PROGRAM = {
  race: { laps: 3, countdown: 3 },
  time: { laps: 1, countdown: 3 },
  drag: { countdown: 3 },
  collect: { countdown: 3 },
  sprint_highway: { countdown: 3, gates: 9, finish: 0.983, pace: [38, 42, 46], grip: 6.7 },
  sprint_canyon: { countdown: 3, gates: 8, finish: 0.979, pace: [30, 34, 38], grip: 5.8 },
  sprint_lakeside: { countdown: 3, gates: 5, finish: 0.952, pace: [28, 31, 35], grip: 5.5 },
  offroad_stampede: { countdown: 3, gates: 7, finish: 0.967, pace: [22, 25, 28], grip: 4.2 },
};

export function gateAt(route, t, halfWidth) {
  const pos = route.curve.getPointAt(t);
  const tan = route.curve.getTangentAt(t).setY(0).normalize();
  return { pos, tan, halfWidth, distance: route.length * t };
}

// Return the fraction of this step at which the car entered the gate plane.
export function crossingFraction(a, b, gate, maxTravel = Infinity) {
  const { pos: p, tan: n, halfWidth } = gate;
  if ((b.x - a.x) ** 2 + (b.z - a.z) ** 2 > maxTravel ** 2) return null;
  const ax = a.x - p.x, az = a.z - p.z, bx = b.x - p.x, bz = b.z - p.z;
  const from = ax * n.x + az * n.z, to = bx * n.x + bz * n.z;
  if (from >= 0 || to < 0) return null;
  const t = -from / (to - from);
  const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
  const y = a.y + (b.y - a.y) * t;
  return Math.abs(x * n.z - z * n.x) <= halfWidth && Math.abs(y - p.y) <= 2.5 ? t : null;
}

export function projectedDistance(route, pos, from, to) {
  const samples = route.samples, n = samples.length - 1;
  let best = Infinity, distance = 0, index = from;
  for (let k = from; k <= to; k++) {
    if (!route.closed && (k < 0 || k >= n)) continue;
    const i = ((k % n) + n) % n;
    const a = samples[i].pos, b = samples[i + 1].pos;
    const dx = b.x - a.x, dz = b.z - a.z;
    const x = pos.x - a.x, z = pos.z - a.z;
    const t = Math.max(0, Math.min(1, (x * dx + z * dz) / (dx * dx + dz * dz || 1)));
    const d = (x - dx * t) ** 2 + (z - dz * t) ** 2;
    if (d < best) { best = d; distance = (i + t) / n * route.length; index = i; }
  }
  return { distance, index, error: Math.sqrt(best) };
}

// Search locally first, then reacquire within the last validated checkpoint sector.
export function sectorProjection(route, pos, cursor, start, end, limit) {
  const scale = (route.samples.length - 1) / route.length;
  const lo = Math.floor(start * scale), hi = Math.max(lo, Math.ceil(end * scale) - 1);
  let result = projectedDistance(route, pos, Math.max(lo, cursor - 12), Math.min(hi, cursor + 12));
  if (result.error > limit) result = projectedDistance(route, pos, lo, hi);
  return result.error <= limit ? result : null;
}

// Braking envelope in meters, independent of event length. Back propagate
// corner speeds so the AI lifts BEFORE the bend, not when already in it.
export function paceProfile(route, grip) {
  const step = 5;
  const n = Math.ceil(route.length / step), spacing = route.length / n;
  const cap = new Float32Array(n + 1);
  const sample = (d) => route.curve.getTangentAt(route.closed
    ? ((d / route.length) % 1 + 1) % 1 : Math.max(0, Math.min(1, d / route.length))).setY(0).normalize();
  for (let i = 0; i <= n; i++) {
    const d = i * spacing;
    const angle = sample(d - 7).angleTo(sample(d + 7));
    cap[i] = Math.min(90, Math.max(7, Math.sqrt(grip * 14 / Math.max(0.001, angle))));
  }
  for (let i = (route.closed ? 2 * n : n) - 1; i >= 0; i--) {
    const k = i % n, next = k + 1 === n && route.closed ? 0 : k + 1;
    cap[k] = Math.min(cap[k], Math.sqrt(cap[next] ** 2 + 2 * 7 * spacing));
  }
  if (route.closed) cap[n] = cap[0];
  return (distance, wet = 0) => {
    const d = route.closed ? ((distance % route.length) + route.length) % route.length : Math.max(0, Math.min(route.length, distance));
    const u = d / spacing, i = Math.min(n - 1, Math.floor(u));
    return (cap[i] + (cap[i + 1] - cap[i]) * (u - i)) * (1 - 0.15 * wet);
  };
}
