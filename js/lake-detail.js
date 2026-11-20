import * as THREE from 'three';
import { LAKE } from './world-guide.js';
import { firCrown } from './scene-detail.js';

const smooth = THREE.MathUtils.smoothstep;
const TAU = Math.PI * 2;

// Paint only the existing terrain: the shoreline stays glued to the physical heightfield.
export function shadeMirrorLake(material, route) {
  const x0 = 370, z0 = -805, width = 490, depth = 510, n = 256;
  const data = new Uint8Array(n * n * 4);
  const pts = route.samples.map(s => s.pos);
  const segments = pts.slice(1).map((b, i) => {
    const a = pts[i], dx = b.x - a.x, dz = b.z - a.z;
    return { a, dx, dz, inv: 1 / Math.max(.001, dx * dx + dz * dz) };
  });
  for (let j = 0, i = 0; j < n; j++) for (let k = 0; k < n; k++, i += 4) {
    const x = x0 + (k + .5) / n * width, z = z0 + (j + .5) / n * depth;
    let d2 = 100;
    for (const { a, dx, dz, inv } of segments) {
      if (Math.abs(x-a.x) > 22 || Math.abs(z-a.z) > 22) continue;
      const t = THREE.MathUtils.clamp(((x-a.x)*dx + (z-a.z)*dz)*inv, 0, 1);
      d2 = Math.min(d2, (x-a.x-dx*t)**2 + (z-a.z-dz*t)**2);
    }
    data[i] = Math.sqrt(d2) * 25.5;
    data[i+3] = 255;
  }
  const mask = new THREE.DataTexture(data, n, n);
  mask.minFilter = mask.magFilter = THREE.LinearFilter;
  mask.needsUpdate = true;
  material.customProgramCacheKey = () => 'mirror-lake-ground';
  material.onBeforeCompile = shader => {
    shader.uniforms.lakeShoulder = { value: mask };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLakeGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLakeGround = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLakeGround;\nuniform sampler2D lakeShoulder;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 lakeP = vLakeGround.xz - vec2(${LAKE.x}.0, ${LAKE.z}.0);
        if (dot(lakeP, lakeP) < 320.0 * 320.0) {
          float r = length(lakeP);
          float mottled = sin(lakeP.x*.31 + sin(lakeP.y*.39)) * sin(lakeP.y*.27);
          float wetBank = (1.0 - smoothstep(142.0, 156.0 + 3.5*mottled, r))
            * (1.0 - smoothstep(-.85, -.25, vLakeGround.y));
          float darkMud = 1.0 - smoothstep(-1.54, -.50, vLakeGround.y);
          vec3 earth = mix(vec3(.135,.103,.069), vec3(.052,.042,.031), darkMud);
          diffuseColor.rgb = mix(diffuseColor.rgb, earth * (.92 + .12*mottled), wetBank*.91);
          float meadow = smoothstep(143.0, 161.0, r) * (1.0 - smoothstep(196.0, 270.0, r));
          float patches = .5 + .5*sin(lakeP.x*.026 + sin(lakeP.y*.036)*1.6) * cos(lakeP.y*.052);
          diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(.88, 1.01, 1.04), vec3(1.34,1.20,.94), patches), meadow);
          vec2 uv = (vLakeGround.xz - vec2(${x0}.0, ${z0}.0)) / vec2(${width}.0, ${depth}.0);
          if (all(greaterThan(uv, vec2(.008))) && all(lessThan(uv, vec2(.992)))) {
            float d = 10.0 * texture2D(lakeShoulder, uv).r;
            float reach = 7.0 + .55*mottled;
            float gravel = 1.0 - smoothstep(4.7, reach, d);
            float fleck = sin(lakeP.x*7.9 + lakeP.y*4.7) * sin(lakeP.y*9.8);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.116,.104,.081)*(.93+.10*mottled+.12*fleck), gravel*.85);
          }
        }`);
  };
}

export function ageMirrorLakePaint(material) {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${key}:mirror-lake-paint`;
  material.onBeforeCompile = shader => {
    compile(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      float wear = smoothstep(.53, .80, roadPattern.g * .60 + roadPattern.b * .40);
      diffuseColor.rgb *= 1.0 - roadPaint * (.05 + .20 * wear);
      #include <roughnessmap_fragment>`);
  };
}

export function addMirrorLakePlanting(parent, world, rich, foliageTex) {
  const group = new THREE.Group();
  group.name = 'mirror-lake-corridor';
  parent.add(group);
  let seed = 9173;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const rocks = [], reeds = [], pines = [], trunks = [], leaves = [];
  const { groundSampler, onAnyRoad, bldColliders } = world;
  const clear = (x, z, radius) => !bldColliders.some(b =>
    Math.abs(x-b.x) < b.hw+radius && Math.abs(z-b.z) < b.hd+radius)
    && [[0,0],[-1,-1],[-1,1],[1,-1],[1,1],[0,1],[0,-1],[1,0],[-1,0]]
      .every(([dx,dz]) => !onAnyRoad({ x:x+dx*radius, z:z+dz*radius }));
  // Break the shoreline into irregular pockets, with clear gaps between stands of reeds.
  for (let i = 0; i < (rich ? 330 : 210); i++) {
    const a = rand()*TAU;
    if (Math.sin(a*5 + .4) + .5*Math.sin(a*11) < -.05) continue;
    const r = LAKE.r - 11 + rand()*29;
    const x = LAKE.x + Math.cos(a)*r, z = LAKE.z + Math.sin(a)*r, y = groundSampler(x,z);
    if (y < -1.47 || y > -.25 || !clear(x,z,1.4)) continue;
    const s = .55 + rand()*1.15;
    if (rand() < .24) rocks.push([x,y+.08,z,s*1.18,s*.49,s*.85,rand()*TAU,0x8a8574]);
    else reeds.push([x,y,z,s*.84,s*(.68+rand()*.47),s*.84,rand()*TAU,rand()<.36 ? 0x9b874e : 0x697b43]);
  }
  const groves = [[457,-455,26],[493,-486,29],[480,-562,22],[522,-634,26],[475,-677,24],[523,-740,35],[573,-383,28],[638,-682,22]];
  for (const [cx,cz, spread] of groves) for (let i = 0; i < (rich ? 18 : 12); i++) {
    const a = rand()*TAU, r = Math.sqrt(rand())*spread;
    const x = cx + r*Math.cos(a), z = cz + r*Math.sin(a), y = groundSampler(x,z);
    const h = 2.5 + rand()*6.2, conifer = rand() < .52;
    const spreadX = conifer ? h*.29 : h*.39;
    if (y < -.45 || !clear(x,z,spreadX+.8) || trunks.some(t => Math.hypot(t[0]-x,t[2]-z)<2.6)) continue;
    const yaw = rand()*TAU;
    trunks.push([x,y+h*.26,z,h*.045,h*.55,h*.045,yaw,0x736048]);
    if (conifer) pines.push([x,y+h*.60,z,spreadX,h*.81,spreadX,yaw,rand()<.5 ? 0x58724c : 0x496951]);
    else {
      const col = rand()<.48 ? 0x65794b : 0x7b8556;
      leaves.push([x,y+h*.67,z,spreadX,h*.36,spreadX*.86,yaw,col]);
      for (const offset of [-1,1]) leaves.push([
        x+Math.cos(yaw)*spreadX*.57*offset,y+h*(.58+rand()*.14),z+Math.sin(yaw)*spreadX*.57*offset,
        spreadX*.70,h*.26,spreadX*.64,yaw+offset,col]);
    }
  }
  const standard = (props = {}) => new THREE.MeshStandardMaterial({ roughness: .95, ...props });
  const tuft = new THREE.BufferGeometry();
  const blades = [], ids = [];
  for (let i = 0; i < 8; i++) {
    const a = i*2.4, x = Math.cos(a)*.36, z = Math.sin(a)*.36, b = blades.length/3;
    const h = .47 + .5 * Math.abs(Math.sin(i*1.8));
    blades.push(x-.043,0,z-.048,x+.043,0,z+.048,x*1.33,h*.62,z*1.33,x*1.63,h,z*1.63);
    ids.push(b,b+1,b+2,b+1,b+3,b+2);
  }
  tuft.setAttribute('position', new THREE.Float32BufferAttribute(blades,3));
  tuft.setIndex(ids); tuft.computeVertexNormals();
  const add = (name, geo, mat, items, shadows = false) => {
    if (!items.length) { geo.dispose(); mat.dispose(); return; }
    const mesh = new THREE.InstancedMesh(geo,mat,items.length);
    const pose = new THREE.Object3D(), color = new THREE.Color();
    items.forEach(([x,y,z,sx,sy,sz,yaw,tint],i) => {
      pose.position.set(x,y,z); pose.scale.set(sx,sy,sz);
      pose.rotation.y = yaw; pose.updateMatrix();
      mesh.setMatrixAt(i,pose.matrix); mesh.setColorAt(i,color.setHex(tint));
    });
    mesh.name = name;
    mesh.receiveShadow = true; mesh.castShadow = rich && shadows;
    group.add(mesh);
  };
  add('mirror-lake-reeds',tuft,standard({side:THREE.DoubleSide}),reeds);
  add('mirror-lake-stones',new THREE.IcosahedronGeometry(1,0),standard(),rocks);
  add('mirror-lake-trunks',new THREE.CylinderGeometry(.31,.58,1,6),standard(),trunks,true);
  add('mirror-lake-conifers',firCrown(),standard({vertexColors:true}),pines,true);
  add('mirror-lake-broadleaf',new THREE.IcosahedronGeometry(1,2),standard({map:foliageTex}),leaves,true);
}
