const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const smooth = (lo, hi, x) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
export const damp = (from, to, dt, rate) => from + (to - from) * (1 - Math.exp(-dt * rate));
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function steerInput(current, input, speed, dt) {
  const target = -clamp(input, -1, 1);
  const high = smooth(15, 48, Math.abs(speed));
  const returning = !target || Math.sign(target) !== Math.sign(current) || Math.abs(target) < Math.abs(current);
  return damp(current, target, dt, returning ? 22 : 18 - 9 * high);
}

// Input-only assist: trim power under sustained large steering, without reading the road.
export function turnAssist(steer, speed, handbrake) {
  const amount = Math.abs(steer);
  const tight = smooth(.45, .92, amount);
  const forward = Math.max(0, speed);
  return {
    power: 1 - .88 * tight * smooth(9, 15, forward),
    slow: handbrake ? 0 : 8.6 * tight * smooth(9.5, 16, forward)
      * (1 - .55 * smooth(22, 42, forward)),
  };
}

export function cornering(steer, speed, grip, wet, surface, handbrake) {
  const v = Math.abs(speed);
  const amount = Math.abs(steer);
  const high = smooth(15, 45, v);
  const drift = handbrake ? smooth(5, 16, v) : 0;
  const kinematic = v * (.194 - .035 * smooth(9, 22, v)) * grip;
  const lateralCap = 9.8 * grip * (1.92 - .57 * high) * (1 - .23 * wet) * (1 - .39 * surface);
  const limit = lateralCap / Math.max(1, v);
  const maxYaw = kinematic / (1 + (kinematic / limit) ** 4) ** .25;
  // Apply the grip envelope to full lock first, so partial steering retains its own range.
  const response = amount * (1 - (.23 + .32 * high) * (1 - amount));
  const load = response * (maxYaw / limit);
  return {
    yawRate: Math.sign(steer * speed) * maxYaw * response * (1 + .48 * drift),
    alignRate: (25 - 7 * high - 5 * smooth(.65, 1, load))
      * (1 - .45 * surface) * (1 - .28 * wet) * (1 - .78 * drift),
    wheel: steer * (.48 - .26 * smooth(8, 50, v)),
  };
}

export function cruiseThrottle(cruise, speed, steer, dt, config) {
  const { KP, KI, MAX_I } = config;
  const bend = smooth(.18, .75, Math.abs(steer));
  const gap = cruise.target - speed;
  if (bend > .05) cruise.integral = damp(cruise.integral, 0, dt, 8 * bend);
  else if (Math.abs(gap) > .02) cruise.integral = clamp(cruise.integral + gap * dt, -MAX_I, MAX_I);
  return clamp(KP * gap + KI * cruise.integral, 0, 1) * (1 - bend);
}
