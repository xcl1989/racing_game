// realism.js — 环境材质真实化（v2.15 建立，v2.29 扩展道具微表面）
// 设计原则：不改动 scenery.js / world.js 的生成代码（避免与并行会话撞车），
// 在世界构建完成后对场景做一次"材质升级遍历"：
//   1. 氛围：晴天雾距拉远（并同步 WEATHER_TYPES preset，防天气过渡打回原样）
//   2. 地面：草地贴图换 V2（有机软斑，去平铺马赛克方块感）+ 草丛法线 + 压环境反射
//   3. 远山：白金字塔 → 顶点色渐变山体（山脚深绿灰→山顶雾蓝）+ 实例色压暗 + 前移
//      （原山在 2350-2600 处被 2700 雾距泡掉 ~90% = 纯白三角）
//   4. v2.29 道具微表面：全场景"纯色无贴图"材质注入细节法线+粗糙度图（materials.js）
import * as THREE from 'three';
import { WEATHER_TYPES } from './weather.js';
import { makeGrassTextureV2, makeGrassNormal, makeMountainTexture, makeMountainNormal } from './textures.js';
import { roadMaterials } from './world.js';
import { enhancePropMaterial } from './materials.js';

// ---- v2.21 湿路反射（3A 观感核心）----
// 天气系统每帧给出 wet 0..1（晴 0 / 多云 0.15 / 阴 0.35 / 雨 1），本函数把世界路网
// 材质朝"湿沥青"插值：粗糙度骤降 + 颜色压暗 + 环境反射增强（天穹 PMREM 镜面感）。
// 从注册表快照取基准值，任意 wet 反复调用幂等，不叠加漂移。
let _roadBase = null;
export function setRoadWet(k) {
  k = THREE.MathUtils.clamp(k, 0, 1);
  if (!_roadBase && roadMaterials.length) {
    _roadBase = roadMaterials.map((m) => ({
      m,
      roughness: m.roughness,
      color: m.color.clone(),
      envMapIntensity: m.envMapIntensity ?? 1,
    }));
  }
  if (!_roadBase) return;
  for (const b of _roadBase) {
    b.m.roughness = THREE.MathUtils.lerp(b.roughness, 0.30, k);      // 湿面镜面
    b.m.metalness = 0.04 + 0.06 * k;                                  // 微金属提亮反射
    b.m.envMapIntensity = b.envMapIntensity * (1 + 1.2 * k);          // 环境反射增强
    b.m.color.copy(b.color).multiplyScalar(1 - 0.28 * k);             // 湿沥青压暗
  }
}

export function upgradeRealism(scene) {
  // ---- 1) 氛围：雾距拉远（只动晴天；阴/雨的近雾是氛围设计，保留）----
  if (scene.fog) {
    scene.fog.near = 420;
    scene.fog.far = 3800;
  }
  const sunny = WEATHER_TYPES && WEATHER_TYPES.sunny;
  if (sunny) {
    sunny.fogNear = 420;
    sunny.fogFar = 3800;
  }

  // ---- 2) 地面材质升级（识别：5200 PlaneGeometry 位移网格）----
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
      // v2.24 山体重制：14 段锥 + 方位角翘曲（v2.15）+ 三频 crag 噪声径向皱缩（新）
      //   + 岩壁层理贴图/法线（新）+ 海拔顶色带与噪声雪线（新）——根治"光滑渐变帐篷"
      const newGeo = new THREE.ConeGeometry(1, 1, 14, 12); // 高度段 8→12：皱缩需要纵向分辨率
      // 确定性伪噪声（同一几何所有实例共享，随机 rotation.y 提供个体差异）
      const crag = (a, h, s) =>
        Math.sin(a * 2.7 + s) * Math.sin(h * 3.1 + a * 1.4 + s * 0.7)
        + 0.5 * Math.sin(a * 5.3 - h * 2.2 + s * 1.3)
        + 0.25 * Math.sin(a * 9.7 + h * 5.9 - s * 0.5);
      {
        const pp = newGeo.attributes.position;
        for (let i = 0; i < pp.count; i++) {
          const vx = pp.getX(i), vy = pp.getY(i), vz = pp.getZ(i);
          const rr = Math.hypot(vx, vz);
          if (rr > 0.01) { // 锥尖不动
            const a = Math.atan2(vz, vx);
            // 径向扰动：打破底盘的圆对称
            const k = 1 + 0.22 * Math.sin(a * 2.1 + 1.7)
              + 0.15 * Math.sin(a * 4.3 + 0.6)
              + 0.09 * Math.sin(a * 7.7 + 2.9);
            // crag 皱缩：山脊锯齿（基座全量、山尖渐隐），世界尺度 = 局部幅度 × 实例宽（~600m×0.075≈45m）
            const h01 = vy + 0.5;
            const fade = Math.min(1, h01 * 4) * (1 - THREE.MathUtils.smoothstep(h01, 0.85, 1));
            const cr = crag(a * 2.0 + 3.0, h01 * 4.0, 1.0) * 0.075 * fade;
            pp.setX(i, vx * k * (1 + cr));
            pp.setZ(i, vz * k * (1 + cr));
            // 剖面翘曲：按方位角改变坡面鼓包——直线三角剖面变起伏山脊
            const warp = 1 + 0.24 * Math.sin(a * 2.3 + 0.9)
              + 0.15 * Math.sin(a * 5.1 + 2.2)
              + crag(a * 1.6, h01 * 3.2, 4.2) * 0.06 * fade; // 纵向也带噪声 → 坡面起伏
            pp.setY(i, h01 * warp - 0.5);
          }
        }
        newGeo.computeVertexNormals();
      }
      // 顶点色：山脚灰绿（接草地）→ 山腰岩灰 → 山顶雾蓝霭 + 噪声雪线（只给高海拔）
      // ⚠️ 注意三层相乘：实例色 × 顶点色 × 岩贴图——这里必须保持高亮度（v2.24 黑墙教训）
      const pos = newGeo.attributes.position;
      const n = pos.count;
      const cols = new Float32Array(n * 3);
      const cBot = new THREE.Color(0x5f6f60);
      const cMid = new THREE.Color(0x93a196);
      const cTop = new THREE.Color(0xc4d0d8);
      const cSnow = new THREE.Color(0xe6ecf1);
      const tmp = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const t = THREE.MathUtils.clamp(pos.getY(i) + 0.5, 0, 1);
        if (t < 0.45) tmp.copy(cBot).lerp(cMid, t / 0.45);
        else tmp.copy(cMid).lerp(cTop, (t - 0.45) / 0.55);
        // 雪线：t>0.68 起按噪声边界过渡（0.3 抖动 → 锯齿状雪缘）
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        const sn = crag(a * 2.4, t * 3.1, 7.7);
        const snowT = THREE.MathUtils.clamp((t - 0.68) * 6 + sn * 0.3, 0, 1);
        tmp.lerp(cSnow, snowT * 0.9);
        cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
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
      // 前移 + 压低：雾浓度从 ~90% 降到 ~45%，山体现出渐变层次
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, mtx);
        mtx.decompose(pv, qv, sv);
        const pull = Math.hypot(pv.x, pv.z) > 1800 ? 0.78 : 0.9;
        pv.x *= pull; pv.z *= pull;
        sv.y *= 0.85;
        sv.z *= 0.82 + Math.random() * 0.25; // 纵深不等轴：剪影不再左右对称
        pv.y = sv.y / 2 - 5;
        mtx.compose(pv, qv, sv);
        o.setMatrixAt(i, mtx);
      }
      o.instanceMatrix.needsUpdate = true;
      mountainDone = true;
    }
  });

  console.log('[realism] ground=%s mountain=%s props=%d', groundDone, mountainDone, propCount);
  return { groundDone, mountainDone, propCount };
}
