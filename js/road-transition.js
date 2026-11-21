import * as THREE from 'three';
import { createRoadMaterial } from './roads.js';

const vec = (x, z, y = .038) => new THREE.Vector3(x, y, z);
const heading = (x, z) => vec(x, z, 0).normalize();
const rightOf = t => vec(-t.z, t.x, 0);

function cubic(a, tangentA, lengthA, b, tangentB, lengthB) {
  return new THREE.CubicBezierCurve3(a, a.clone().addScaledVector(tangentA, lengthA),
    b.clone().addScaledVector(tangentB, -lengthB), b);
}

// CurvePath.getPoint already evaluates by distance along its child curves.
class RoadPath extends THREE.CurvePath {
  getPointAt(t) { return this.getPoint(t); }
  getTangentAt(t) { return this.getTangent(t); }
}

function highwayApproach(highway, { start, toward, junction, handles, width }) {
  const end = highway.samples.reduce((a,b) =>
    b.pos.distanceToSquared(junction) < a.pos.distanceToSquared(junction) ? b : a);
  const normal = rightOf(end.tan);
  if (end.pos.clone().sub(start).dot(normal) < 0) normal.negate();
  // Meet the through road at right angles; the slight dip lets its edge and
  // centre lines stay continuous across the T, without coplanar overlays.
  const terminal = end.pos.clone().setY(.012);
  const mouth = terminal.clone().addScaledVector(normal, -19).setY(.044);
  const curve = new RoadPath();
  curve.add(cubic(start, toward, handles[0], mouth, normal, handles[1]));
  curve.add(new THREE.LineCurve3(mouth, terminal));
  return { curve, junction: end.pos, width };
}

export function publicApproaches(highway, city) {
  const { eastX, westX, outerZ, lakeZ } = city;
  const east = highwayApproach(highway, { start: vec(eastX + 5.7, 350), toward: heading(1, 0),
    junction: vec(1860, 360), handles: [165, 130], width: 12 });
  const belt = highwayApproach(highway, { start: vec(1050, outerZ + 5.7), toward: heading(0, 1),
    junction: vec(806, 1015), handles: [153, 139], width: 12 });
  const start = vec(westX, lakeZ - 5.7), bend = vec(784, -115), end = vec(820, -402, .023);
  const straight = heading(0, -1), tangent = heading(.06, -1);
  const lake = new RoadPath();
  lake.add(cubic(start, straight, 63, bend, tangent, 79));
  const approach = vec(827, -339);
  lake.add(cubic(bend, tangent, 95, approach, heading(0, -1), 72));
  lake.add(cubic(approach, heading(0, -1), 21, end, heading(-.07, -1), 20));
  return { east, belt, lake };
}

// Shared unpainted asphalt on the approaches; build only one marking mesh.
export function addApproachMarkings(parent, roads) {
  const positions = [], indices = [], colors = [];
  const white = new THREE.Color(0xe0ded3), yellow = new THREE.Color(0xd8b54c);
  function strip(road, from, to, l, r, color) {
    const n = Math.max(1, Math.ceil((to - from) / 2));
    const base = positions.length / 3;
    for (let i=0; i<=n; i++) {
      const t = THREE.MathUtils.lerp(from, to, i/n) / road.length;
      const p = road.curve.getPointAt(t), side = rightOf(road.curve.getTangentAt(t));
      p.y += .009;
      for (const off of [r,l]) {
        positions.push(p.x + side.x*off, p.y, p.z + side.z*off);
        colors.push(color.r,color.g,color.b);
      }
      if (i) { const k=base+i*2; indices.push(k-2,k-1,k,k-1,k+1,k); }
    }
  }
  for (const { route, endGap, stop } of roads) {
    const end = route.length - endGap, edge = route.samples[0].w / 2 - .36;
    for (const offset of [-edge, edge]) strip(route, 1.1, end, offset-.07, offset+.07, white);
    for (const offset of [-.15,.15]) {
      strip(route, 1.5, 31, offset-.055, offset+.055, yellow);
      strip(route, end-44, end, offset-.055, offset+.055, yellow);
    }
    for (let s=35;s<end-49;s+=13) strip(route, s, s+4, -.065, .065, yellow);
    if (stop) strip(route, end-.85, end-.56, .3, edge, white);
    else for (let x=.6;x<edge-.28;x+=.66) strip(route, end-1.05, end-.77, x-.23, x+.23, white);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  geo.setIndex(indices); geo.computeVertexNormals();
  const mat = createRoadMaterial('marking', { vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'regional-road-markings'; mesh.receiveShadow = true;
  parent.add(mesh);
}

export function localPatrol(id, route, trimStart, trimEnd) {
  const length = route.length - trimStart - trimEnd;
  const fraction = t => (trimStart + t*length) / route.length;
  return { id, length, closed: false,
    curve: { getPointAt: t => route.curve.getPointAt(fraction(t)), getTangentAt: t => route.curve.getTangentAt(fraction(t)) } };
}
