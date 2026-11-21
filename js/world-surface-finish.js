import * as THREE from 'three';
import { roadDetailTexture, visualWetness } from './roads.js';
import { LAKE, FOOTHILL_LAKE, RIVER } from './world-guide.js';

const smooth = THREE.MathUtils.smoothstep;
const mix = THREE.MathUtils.lerp;
const mtn = { x: 350, z: -1380, r: 520 };
const near = (d, inner, outer) => 1 - smooth(d, inner, outer);
const ell = (x, z, cx, cz, rx, rz) => Math.hypot((x - cx) / rx, (z - cz) / rz);

// The main plane and the drivable mountain use the same palette at their seam.
// Tones here are linear multipliers for the existing grass albedo.
export function terrainTint(x, z, h, slope, out) {
  const patch = Math.sin(x * .017 + z * .007) * Math.cos(z * .013 - x * .004);
  const shade = .88 + Math.sin(x * .0045) * Math.cos(z * .0035) * .11 + patch * .09;
  const city = near(ell(x,z,1050,350,430,420), .4, 1.15);
  const valley = near(ell(x,z,-850,-300,830,1250), .24, 1.08);
  const north = near(ell(x,z,590,1010,850,470), .3, 1.06);
  const lakeR = Math.hypot(x - LAKE.x, z - LAKE.z);
  const foothillR = Math.hypot(x - FOOTHILL_LAKE.x, z - FOOTHILL_LAKE.z);
  const lake = Math.max(near(lakeR, 180, 410), near(foothillR, 230, 560));
  let r = shade * (1.00 + .22*valley + .08*north - .11*lake - .09*city);
  let g = shade * (.99 - .12*valley - .05*north + .04*lake - .10*city);
  let b = shade * (.87 - .14*valley + .19*lake + .09*city);
  const alpine = near(Math.hypot(x-mtn.x,z-mtn.z), mtn.r-110, mtn.r);
  const stone = alpine * smooth(h + patch * 12 + slope * 125, 19, 61);
  const bank = Math.max(near(lakeR, 138, 179), near(foothillR, 188, 241),
    near(Math.abs(x - RIVER.x), 36, 79) * near(Math.abs(z), RIVER.halfLength-130, RIVER.halfLength));
  const silt = bank * near(h, -1.35, .18);
  const wet = near(h, -1.70, -.45);
  r = mix(mix(r, 1.04 + patch*.13, stone), mix(1.03,.59,wet), silt);
  g = mix(mix(g, .69 + patch*.08, stone), mix(.76,.43,wet), silt);
  b = mix(mix(b, .86 + patch*.09, stone), mix(.65,.39,wet), silt);
  return out.setRGB(r, g, b);
}

// One shared tiled texture, sampled in world meters even on scaled instances.
// Chain existing hooks so the hand-painted Mirror Lake shoulder is preserved.
export function addSurfaceFinish(material, kind) {
  const compile = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey();
  material.userData.surfaceFinish = kind;
  material.onBeforeCompile = function(shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.worldFinish = { value: roadDetailTexture() };
    shader.uniforms.finishWet = visualWetness;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFinishPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 finishPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          finishPosition = instanceMatrix * finishPosition;
        #endif
        vFinishPos = (modelMatrix * finishPosition).xyz;`);
    const ground = kind === 'terrain';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFinishPos;
        uniform sampler2D worldFinish;
        uniform float finishWet;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${ground ? `
          vec3 finishGrain = texture2D(worldFinish, vFinishPos.xz / 12.0).rgb;
          float finishTone = dot(finishGrain - .5, vec3(.32,.13,.15));
          diffuseColor.rgb *= (1.0 + finishTone) * (1.0 - finishWet * mix(.08,.22,finishGrain.r));
        ` : `
          vec2 finishUV = ${kind === 'bark'
            ? 'vec2(vFinishPos.x * 1.35 + vFinishPos.z * 1.51, vFinishPos.y * .11)'
            : 'vec2(vFinishPos.x + vFinishPos.z * .73, vFinishPos.y + vFinishPos.z * .63)'};
          vec3 finishGrain = texture2D(worldFinish, finishUV * ${kind === 'bark' ? '1.0' : '.22'}).rgb;
          float finishTone = dot(finishGrain - .5, ${kind === 'bark' ? 'vec3(.51,.18,.12)' : 'vec3(.28,.16,.18)'});
          diffuseColor.rgb *= (1.0 + finishTone) * (1.0 - finishWet * mix(.06,.18,finishGrain.g));
        `}`);
  };
  material.customProgramCacheKey = () => `${cacheKey}:world-finish-v1:${kind}`;
  return material;
}

// Window positions match the source facade atlases; walls and mullions stay matte.
const facadeRoughness = {};
const uuidWord = new Uint32Array(1);
function makeFacadeMap(factory) {
  const random = Math.random;
  try {
    Math.random = () => globalThis.crypto.getRandomValues(uuidWord)[0] / 0x100000000;
    return factory();
  } finally {
    Math.random = random;
  }
}
export function facadeFinish(map, glass) {
  const key = glass ? 'glass' : 'masonry';
  if (!facadeRoughness[key]) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.scale(.5,.5);
    ctx.fillStyle = glass ? '#c4c4c4' : '#f5f5f5'; ctx.fillRect(0,0,512,512);
    const rows = glass ? 3 : 4, columns = glass ? 6 : 8;
    for (let j=0;j<rows;j++) for (let i=0;i<columns;i++) {
      const v = (i*7 + j*13) % 5;
      const shade = (glass ? 88 : 104) + v * 11;
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      if (glass) ctx.fillRect(i*85+2,j*170+1,78,158);
      else ctx.fillRect(i*64+15,j*128+33,36,66);
    }
    const texture = makeFacadeMap(() => new THREE.CanvasTexture(canvas));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    facadeRoughness[key] = texture;
  }
  const tex = makeFacadeMap(() => facadeRoughness[key].clone());
  tex.repeat.copy(map.repeat);
  tex.needsUpdate = true;
  return tex;
}
