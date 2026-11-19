import * as THREE from 'three';

// East-facing afternoon sun. The disc, direct light and reflection use this vector.
export const SUN_DIRECTION = new THREE.Vector3(60, 110, 45).normalize();
export const SUN_OFFSET = SUN_DIRECTION.clone().multiplyScalar(Math.hypot(60, 110, 45));
export const SUN_U = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x) / (2 * Math.PI) + 0.5;
export const SUN_V = Math.asin(SUN_DIRECTION.y) / Math.PI + 0.5;

export function createOutdoorEnvironment(pmrem) {
  const w = 256, h = 128;
  const pixels = new Uint16Array(w * h * 4);
  const tex = new THREE.DataTexture(pixels, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  const half = THREE.DataUtils.toHalfFloat;
  const color = new THREE.Color();
  // Cache directional terms; each bake only mixes the current weather palette.
  const samples = new Float32Array(w * h * 4);
  for (let j = 0, i = 0; j < h; j++) {
    const lat = ((j + 0.5) / h - 0.5) * Math.PI;
    for (let x = 0; x < w; x++, i += 4) {
      const lon = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const y = Math.sin(lat);
      const dot = Math.cos(lat) * (Math.cos(lon) * SUN_DIRECTION.x + Math.sin(lon) * SUN_DIRECTION.z) + y * SUN_DIRECTION.y;
      samples[i] = y;
      samples[i+1] = Math.exp((dot - 1) * 380) * 11 + Math.exp((dot - 1) * 32) * 0.65;
      // Broad cloud bands give curved panels a readable reflection without a second render pass.
      const cloud = Math.sin(lon * 3 + y * 9) + 0.36 * Math.sin(lon * 7 - y * 21);
      samples[i+2] = THREE.MathUtils.smoothstep(cloud, 0.2, 1.05) * Math.exp(-((y - 0.38) ** 2) * 13);
      const skyline = -0.018 + 0.017 * Math.sin(lon * 6 + 1) + 0.007 * Math.sin(lon * 17);
      samples[i+3] = THREE.MathUtils.smoothstep(y, skyline - 0.014, skyline + 0.014);
    }
  }
  let target = null;
  return (p) => {
    for (let i = 0; i < pixels.length; i += 4) {
      const y = samples[i];
      const sky = p.zenith;
      if (y >= 0) {
        color.copy(p.horizon).lerp(p.mid, Math.min(1, y * 2.5));
        color.lerp(sky, THREE.MathUtils.smoothstep(y, 0.38, 1));
      } else {
        color.copy(p.horizon).lerp(p.g1, Math.min(1, -y * 50));
        color.lerp(p.g2, Math.min(1, -y * 4)).lerp(p.g3, Math.max(0, -y));
      }
      const horizonShade = 0.70 + 0.30 * samples[i+3];
      color.multiplyScalar(horizonShade);
      const cloud = samples[i+2] * (0.35 + 0.10 * p.cloudMul) * samples[i+3];
      const sun = p.sunGlow * samples[i+1];
      pixels[i] = half(color.r + p.horizon.r * cloud + p.sunColor.r * sun);
      pixels[i+1] = half(color.g + p.horizon.g * cloud + p.sunColor.g * sun);
      pixels[i+2] = half(color.b + p.horizon.b * cloud + p.sunColor.b * sun);
      pixels[i+3] = half(1);
    }
    tex.needsUpdate = true;
    target = pmrem.fromEquirectangular(tex, target);
    return target.texture;
  };
}
