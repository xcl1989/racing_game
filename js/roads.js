import * as THREE from 'three';

// All four surfaces are dielectrics. Only asphalt develops a smooth water film.
const profiles = {
  asphalt: { darken: 0.24, wetRough: 0.22, env: 0.56, wetEnv: 1.38, variation: 0.15, edges: 1 },
  dirt: { darken: 0.44, wetRough: 0.77, env: 0.27, wetEnv: 0.29, variation: 0.22, edges: 0 },
  concrete: { darken: 0.24, wetRough: 0.68, env: 0.36, wetEnv: 0.44, variation: 0.16, edges: 0 },
  marking: { darken: 0.09, wetRough: 0.54, env: 0.48, wetEnv: 0.56, variation: 0.03, edges: 0 },
};
const roadWetness = { value: 0 };
let detailTexture;

export function setRoadWet(wet) {
  roadWetness.value = THREE.MathUtils.clamp(wet, 0, 1);
}

function roadDetail() {
  if (detailTexture) return detailTexture;
  const size = 128, data = new Uint8Array(size * size * 4);
  // Seamless, seeded value noise; does not consume the world's random stream.
  function sample(x, y, cells, salt) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const dx = x - ix, dy = y - iy;
    const sx = dx * dx * (3 - 2 * dx), sy = dy * dy * (3 - 2 * dy);
    const lattice = (a, b) => {
      let n = Math.imul((a % cells) + 1, 1597334677) ^ Math.imul((b % cells) + salt, 3812015801);
      n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(lattice(ix, iy), lattice(ix + 1, iy), sx),
      THREE.MathUtils.lerp(lattice(ix, iy + 1), lattice(ix + 1, iy + 1), sx), sy);
  }
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i += 4) {
    data[i] = 255 * sample(x / 16, y / 16, 8, 7);
    data[i + 1] = 255 * sample(x / 8, y / 8, 16, 17);
    data[i + 2] = 255 * sample(x / 4, y / 4, 32, 29);
    data[i + 3] = 255;
  }
  detailTexture = new THREE.DataTexture(data, size, size);
  detailTexture.wrapS = detailTexture.wrapT = THREE.RepeatWrapping;
  detailTexture.minFilter = THREE.LinearMipmapLinearFilter;
  detailTexture.magFilter = THREE.LinearFilter;
  detailTexture.generateMipmaps = true;
  detailTexture.needsUpdate = true;
  return detailTexture;
}

export function createRoadMaterial(kind, options) {
  const p = profiles[kind];
  // Use the world-space
  // layer independently of texture UVs so existing lane dimensions stay fixed.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.92, ...options, metalness: 0, envMapIntensity: p.env });
  material.userData.roadSurface = kind;
  material.customProgramCacheKey = () => `road-surface-v2:${kind}`;
  const f = (n) => n.toFixed(3);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.roadWetness = roadWetness;
    shader.uniforms.roadDetail = { value: roadDetail() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRoadWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 roadPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          roadPosition = instanceMatrix * roadPosition;
        #endif
        vRoadWorld = (modelMatrix * roadPosition).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vRoadWorld;
        uniform float roadWetness;
        uniform sampler2D roadDetail;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 roadPattern = texture2D(roadDetail, vRoadWorld / 64.0).rgb;
        float roadPaint = ${kind === 'marking' ? '1.0' : '0.0'};
        float roadEdge = 0.0;
        ${kind === 'asphalt' ? `
        #ifdef USE_MAP
          // Existing asphalt atlases encode bright white/yellow paint over dark aggregate.
          roadPaint = smoothstep(0.15, 0.39, max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b));
          roadEdge = smoothstep(0.43, 0.50, abs(vMapUv.x - 0.5)) * ${f(p.edges)};
        #endif` : ''}
        float roadDose = roadWetness * mix(0.40, 1.0, smoothstep(0.22, 0.76, roadPattern.r));
        float roadFilm = roadWetness * smoothstep(0.31, 0.69, roadPattern.r * 0.68 + roadPattern.g * 0.32);
        float roadVariation = (dot(roadPattern, vec3(0.54, 0.32, 0.14)) - 0.5) * 2.0;
        diffuseColor.rgb *= 1.0 + roadVariation * ${f(p.variation)} * (1.0 - 0.85 * roadPaint);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.10, 1.01, 0.88), roadEdge * (1.0 - roadPaint) * (1.0 - roadWetness * 0.65));
        diffuseColor.rgb *= 1.0 - roadDose * mix(${f(p.darken)}, 0.09, roadPaint);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, mix(${f(p.wetRough)}, 0.54, roadPaint), roadFilm);
        roughnessFactor = clamp(roughnessFactor + roadVariation * 0.04, 0.12, 1.0);`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        #if defined(USE_ENVMAP) && defined(RE_IndirectSpecular)
          radiance *= mix(1.0, mix(${f(p.wetEnv / p.env)}, 1.15, roadPaint), roadFilm);
        #endif`);
  };
  return material;
}
