// realism.js — 环境材质真实化（v2.15 建立，v2.29 扩展道具微表面）
// 设计原则：不改动 scenery.js / world.js 的生成代码（避免与并行会话撞车），
// 在世界构建完成后对场景做一次"材质升级遍历"：
//   1. 地面：草地贴图换 V2（有机软斑，去平铺马赛克方块感）+ 草丛法线 + 压环境反射
//   2. 远山：重塑装饰山脊的轮廓和岩草色过渡，不改可驾地形。
//   3. v2.29 道具微表面：全场景"纯色无贴图"材质注入细节法线+粗糙度图（materials.js）
import * as THREE from 'three';
import { makeGrassTextureV2, makeGrassNormal, makeMountainTexture, makeMountainNormal } from './textures.js';
import { enhancePropMaterial } from './materials.js';

export function upgradeRealism(scene) {
  // ---- 地面材质升级（识别：5200 PlaneGeometry 位移网格）----
  const mtx = new THREE.Matrix4();
  const pv = new THREE.Vector3(), qv = new THREE.Quaternion(), sv = new THREE.Vector3();
  let groundDone = false, mountainDone = false, propCount = 0;
  const seenMat = new Set();
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;

    // ---- v2.29 道具微表面增强 ----
    // 护栏/路灯/看台/油桶/轮胎墙/树干/桥梁/龙门架等"纯色无贴图"材质，
    // 注入程序化细节法线 + 粗糙度微变化图（金属拉丝/橡胶颗粒/涂漆橘皮三档，
    // 材质级去重见 materials.js）。已重制的路面/建筑/植被/水面自动跳过。
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (seenMat.has(m.uuid)) continue;
      seenMat.add(m.uuid);
      if (enhancePropMaterial(m)) propCount++;
    }

    const geo = o.geometry;
    if (!geo || !geo.parameters) return;

    // 地面：换贴图 + 法线 + 压环境反射 + 顶点色宏观色区
    if (!groundDone && o.isMesh && geo.type === 'PlaneGeometry' && geo.parameters.width === 5200) {
      const m = o.material;
      if (m) {
        if (m.map && m.map.dispose) m.map.dispose();
        m.map = makeGrassTextureV2(170); // 与原 170 repeat 相同：30.6m/格
        m.normalMap = makeGrassNormal(800);
        m.normalScale = new THREE.Vector2(0.8, 0.8);
        m.envMapIntensity = 0.45; // 草地别反射天空发亮，哑光更自然
        // v2.22 宏观色区：两张 30m 平铺贴图糊满 5200m 的"贴图感"靠大尺度色彩破除——
        // 世界坐标双频正弦算干湿色区，乘在贴图上（沃绿 ↔ 干草黄 ±12%），零额外采样成本
        const pos = geo.attributes.position;
        const cols = new Float32Array(pos.count * 3);
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          const x = v.x, z = v.z;
          const n = Math.sin(x * 0.008 + 1.3) * Math.sin(z * 0.006 + 4.1)
            + 0.5 * Math.sin(x * 0.021 + z * 0.017)
            + 0.35 * Math.sin(x * 0.043 - z * 0.031 + 2.2); // [-1.85, 1.85]
          const t = THREE.MathUtils.clamp(n / 1.85 * 0.5 + 0.5, 0, 1);
          // v2.29 裸土斑：大尺度低频噪声（斑块 200~800m）选出枯草/裸土区，
          // 顶点色往土色方向乘（43m 顶点粒度足以承载该尺度，零贴图零采样成本）
          const n2 = Math.sin(x * 0.0071 + 2.7) * Math.sin(z * 0.0053 + 1.1)
            + 0.6 * Math.sin(x * 0.0028 - z * 0.0034 + 5.2)
            + 0.4 * Math.sin(x * 0.012 + z * 0.016 + 0.7);
          const w = THREE.MathUtils.smoothstep(n2, 0.55, 1.35);
          cols[i * 3] = (0.88 + 0.24 * t) * (1 + 0.30 * w);      // 裸土偏红（R 升）
          cols[i * 3 + 1] = (0.94 + 0.06 * t) * (1 - 0.36 * w);  // 裸土 G 降
          cols[i * 3 + 2] = (0.92 - 0.18 * t) * (1 - 0.55 * w);  // 裸土 B 大降
        }
        geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        m.vertexColors = true;
        m.needsUpdate = true;
        groundDone = true;
      }
      return;
    }

    // 远山：ConeGeometry(1,1,5) 实例群
    if (!mountainDone && o.isInstancedMesh && geo.type === 'ConeGeometry'
        && geo.parameters.radialSegments === 5 && o.count > 20) {
      // Deform the decorative range only; the driveable heightfield is untouched.
      const newGeo = new THREE.ConeGeometry(1, 1, 24, 14);
      const pos = newGeo.attributes.position;
      const cols = new Float32Array(pos.count * 3);
      const smooth = THREE.MathUtils.smoothstep;
      const grass = new THREE.Color(0x889387), rock = new THREE.Color(0xa1a9a6);
      const tint = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i), t = pos.getY(i) + .5;
        const a = Math.atan2(z, x);
        const ridge = .62 * Math.sin(3*a + t*1.8) + .27 * Math.sin(5*a - t*4.2) + .11 * Math.sin(9*a + t*7.1);
        const shape = (1 + .26*Math.cos(2*a-.8) + .13*ridge) * (1 + .44*t);
        const shoulder = Math.sin(Math.PI*t) * (.105*ridge + .08*Math.sin(2*a-1.3));
        const height = t * t * (3 - 2*t) + shoulder;
        pos.setXYZ(i, x*shape + .22*t*t, height - .5, z*shape - .09*t*t);
        tint.copy(grass).lerp(rock, smooth(height + ridge*.18, .23, .93));
        tint.multiplyScalar(1 + ridge*.11);
        tint.toArray(cols, i*3);
      }
      newGeo.computeVertexNormals();
      // Cone side normals at the UV seam need the same lighting on both copies.
      const normals = newGeo.attributes.normal;
      for (let row = 0; row <= 14; row++) {
        const left = row*25, right = left+24;
        const x = normals.getX(left) + normals.getX(right);
        const y = normals.getY(left) + normals.getY(right);
        const z = normals.getZ(left) + normals.getZ(right);
        const len = Math.hypot(x, y, z) || 1;
        normals.setXYZ(left, x/len, y/len, z/len);
        normals.setXYZ(right, x/len, y/len, z/len);
      }
      newGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      o.geometry = newGeo;
      geo.dispose();
      const mtnMat = o.material;
      mtnMat.map = makeMountainTexture();       // 岩壁层理 + 蚀沟 + 植被斑
      mtnMat.map.repeat.set(3, 2);
      mtnMat.normalMap = makeMountainNormal();  // 层理凹凸
      mtnMat.normalMap.repeat.set(3, 2);
      mtnMat.normalScale = new THREE.Vector2(0.7, 0.7);
      mtnMat.envMapIntensity = 0.3;             // 远山哑光：勿反天空发亮
      mtnMat.vertexColors = true;
      mtnMat.flatShading = false; // 平面着色放大棱面感，远山用平滑渐变
      mtnMat.needsUpdate = true;
      // 实例色：保留微差，明度接近雾色（雾只做最后融合）
      const col = new THREE.Color();
      for (let i = 0; i < o.count; i++) {
        o.getColorAt(i, col);
        col.multiplyScalar(0.97); // 保留微差但几乎不压暗（三层相乘防黑墙）
        o.setColorAt(i, col);
      }
      if (o.instanceColor) o.instanceColor.needsUpdate = true;
      // Broader, lower shoulders connect the range instead of isolated cones.
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, mtx);
        mtx.decompose(pv, qv, sv);
        const pull = Math.hypot(pv.x, pv.z) > 1800 ? 0.78 : 0.9;
        pv.x *= pull; pv.z *= pull;
        sv.x *= 1.16;
        sv.y *= 0.67 + 0.10 * Math.sin(i * 1.73);
        sv.z *= 0.88 + Math.random() * 0.25; // 纵深不等轴：剪影不再左右对称
        pv.y = sv.y / 2 - 5;
        mtx.compose(pv, qv, sv);
        o.setMatrixAt(i, mtx);
      }
      o.instanceMatrix.needsUpdate = true;
      o.computeBoundingSphere();
      mountainDone = true;
    }
  });

  console.log('[realism] ground=%s mountain=%s props=%d', groundDone, mountainDone, propCount);
  return { groundDone, mountainDone, propCount };
}
