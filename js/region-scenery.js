import * as THREE from 'three';
import { HALF_WIDTH } from './track.js';
import { FOOTHILL_LAKE, RIVER } from './world-guide.js';
import { firCrown } from './scene-detail.js';
import { addSurfaceFinish } from './world-surface-finish.js';

// Sparse silhouettes fill the river corridor and the alpine approaches. The
// horizontal footprint bounds all rotated instances, with extra room at roads.
export function addRegionScenery(scene, track, world, rich) {
  const anchors = [
    ...[-1190, -770, -390, 270, 640, 1080, 1420].flatMap((z, i) =>
      [-1, 1].map(side => ['river', RIVER.x + side * (54 + i % 3 * 7), z + side * 27, 34])),
    ...[[560,-1100],[110,-1130],[67,-1470],[340,-1730],[670,-1450],[521,-1540],[225,-1370]]
      .map(([x,z]) => ['alpine', x,z,48]),
    ...[.6, 1.75, 2.9, 4.35, 5.7].map(a => ['alpine',
      FOOTHILL_LAKE.x + Math.cos(a)*247, FOOTHILL_LAKE.z + Math.sin(a)*247, 32]),
  ];
  let seed = 23845;
  const rand = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0) / 4294967296);
  const bundles = { rock: [], pine: [], trunk: [], reed: [] };
  const occupied = [];
  const maxInstances = rich ? 220 : 140;
  let instanceCount = 0;
  const sample = new THREE.Vector3();
  const clear = (x,z,r) => world.distToRoads(x,z) > r+12.5
    && track.nearestSample(sample.set(x,0,z)).d > HALF_WIDTH+r+2
    && track.distToStrip(x,z) > track.strip.width/2+r+2
    && !world.bldColliders.some(b => Math.abs(x-b.x)<b.hw+r && Math.abs(z-b.z)<b.hd+r)
    && !occupied.some(b => Math.hypot(b.x-x,b.z-z) < b.r+r+.4);
  for (const [region,cx,cz,spread] of anchors) {
    for (let i=0;i<(rich?8:5);i++) {
      const a = rand()*Math.PI*2, radius = Math.sqrt(rand())*spread;
      const x = cx+Math.cos(a)*radius, z = cz+Math.sin(a)*radius;
      const y = world.groundSampler(x,z), yaw = rand()*Math.PI*2, pick = rand();
      const size = rand();
      if (instanceCount >= maxInstances) break;
      if (region === 'river' && y < -.13) {
        if (y < -1.38 || !clear(x,z,.92)) continue;
        const h = .75 + size*.65;
        bundles.reed.push([x,y+h*.15,z,.9,h,.9,yaw,pick<.38?0x938552:0x79824c]);
        occupied.push({x,z,r:.92});
        instanceCount++;
      } else if (region === 'alpine' && pick > .32) {
        const h = 3.9 + size*4.8, w = h*.25;
        if (instanceCount+2 > maxInstances || !clear(x,z,w) || y<-.25) continue;
        bundles.pine.push([x,y+h*.58,z,w,h*.80,w,yaw,size<.6?0x537050:0x677b55]);
        bundles.trunk.push([x,y+h*.26,z,h*.047,h*.54,h*.047,yaw,0x78634d]);
        occupied.push({x,z,r:w});
        instanceCount += 2;
      } else {
        const w = .65 + size*(region==='alpine'?1.65:.85);
        if (y<-.32 || !clear(x,z,w*1.25)) continue;
        bundles.rock.push([x,y+w*.16,z,w,w*(.48+pick*.5),w*.7,yaw,region==='alpine'?0x96938b:0x8d8271]);
        occupied.push({x,z,r:w*1.25});
        instanceCount++;
      }
    }
  }
  // Three r160 uses Math.random for UUIDs. Only these synchronous allocations
  // are isolated; placements use the independent seed above.
  const random = Math.random;
  const bytes = new Uint32Array(1);
  try {
    Math.random = () => globalThis.crypto.getRandomValues(bytes)[0] / 0x100000000;
    const group = new THREE.Group(); group.name = 'regional-landscape';
    const tint = new THREE.Color(), pose = new THREE.Object3D();
    const add = (kind, geometry, material) => {
      if (!bundles[kind].length) { geometry.dispose(); material.dispose(); return; }
      const mesh = new THREE.InstancedMesh(geometry,material,bundles[kind].length);
      mesh.name = `regional-${kind}`;
      mesh.receiveShadow = true;
      for (const [i,[x,y,z,w,h,d,yaw,color]] of bundles[kind].entries()) {
        pose.position.set(x,y,z); pose.scale.set(w,h,d); pose.rotation.y = yaw; pose.updateMatrix();
        mesh.setMatrixAt(i,pose.matrix); mesh.setColorAt(i,tint.setHex(color));
      }
      group.add(mesh);
    };
    const mat = (options = {}) => new THREE.MeshStandardMaterial({ roughness:.94, ...options });
    add('rock',new THREE.IcosahedronGeometry(1,0),addSurfaceFinish(mat({flatShading:true}),'stone'));
    add('pine',firCrown(),mat({vertexColors:true}));
    add('trunk',new THREE.CylinderGeometry(.45,.68,1,6),addSurfaceFinish(mat(),'bark'));
    // Two crossed reed fans, not opaque quads.
    const reed = new THREE.BufferGeometry(), verts = [];
    for (const angle of [0,Math.PI/2]) for (let i=-2;i<=2;i++) {
      const dx = Math.cos(angle), dz = Math.sin(angle), x = i*.12;
      verts.push(dx*(x-.049),-.2,dz*(x-.049), dx*(x+.049),-.2,dz*(x+.049), dx*(i*.32),.81-Math.abs(i)*.1,dz*(i*.32));
    }
    reed.setAttribute('position',new THREE.Float32BufferAttribute(verts,3)); reed.computeVertexNormals();
    add('reed',reed,mat({side:THREE.DoubleSide}));
    scene.add(group);
  } finally {
    Math.random = random;
  }
}
