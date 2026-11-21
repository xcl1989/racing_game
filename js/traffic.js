import { paceProfile } from './race-rules.js';

export function prepareTraffic(route) {
  route.trafficPace = paceProfile(route, 3.6);
}

export function trafficTargets(cars, lights, signalAt, wet) {
  for (const [i, car] of cars.entries()) {
    if (!car.group.visible) continue;
    const { pos, speed, route } = car;
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const brake = 3.5 * (1 - 0.2 * wet);
    let cap = route.trafficPace?.(car.total, wet) ?? car.baseSpeed;
    for (const light of lights) {
      const x = light.pos.x - pos.x, z = light.pos.z - pos.z;
      const front = x * fx + z * fz, lateral = x * fz - z * fx;
      if (front < 6.4 || front > 50 || Math.abs(lateral) > 5.3) continue;
      const axis = Math.abs(fx) > Math.abs(fz) ? 'x' : 'z';
      const phase = signalAt(light, axis);
      const room = Math.max(0, front - 9);
      if (phase === 0 || (phase === 1 && speed * speed <= 2 * brake * room)) {
        cap = Math.min(cap, Math.sqrt(2 * brake * room));
      }
    }
    for (let j = 0; j < cars.length; j++) {
      const other = cars[j];
      if (j === i || !other.group.visible || Math.abs(pos.y - other.pos.y) > 2) continue;
      const x = other.pos.x - pos.x, z = other.pos.z - pos.z;
      const front = x * fx + z * fz, lateral = x * fz - z * fx;
      if (front <= 0 || front > 50 || Math.abs(lateral) > 45) continue;
      const ox = Math.sin(other.yaw), oz = Math.cos(other.yaw);
      const heading = fx * ox + fz * oz;
      if (Math.abs(lateral) < 1.9 && heading > 0.4) {
        const gap = Math.max(0, front - 5.5 - speed * 0.35);
        cap = Math.min(cap, Math.sqrt((other.speed * heading) ** 2 + 2 * brake * gap));
      } else if (Math.abs(heading) < 0.72) {
        const cross = fx * oz - fz * ox;
        const enter = (x * oz - z * ox) / cross;
        const otherEnter = (x * fz - z * fx) / cross;
        if (enter < 0 || enter > 32 || otherEnter < -3 || otherEnter > 30) continue;
        const occupied = Math.abs(otherEnter) < 4;
        if (occupied || (j < i && other.speed > 1 && otherEnter / other.speed < enter / Math.max(5, speed) + 1.2)) {
          cap = Math.min(cap, Math.sqrt(2 * brake * Math.max(0, enter - 5)));
        }
      }
    }
    car.trafficTarget = cap;
  }
}
