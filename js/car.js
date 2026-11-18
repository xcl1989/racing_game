// car.js — 车辆：Ferrari GLB 真车模（Draco）+ 街机物理 + AI 跟车
// 加载失败时自动回退到程序化拼装车；玩家车按 spec 差异化物理
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HALF_WIDTH } from './track.js';
import { buildCarModel } from './cars.js';

// ---- GLB 模板加载（一次加载，多车克隆）----
let _loader = null;
function getLoader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('models/draco/'); // 本地解码器，避免 CDN WASM 加载卡死
    _loader.setDRACOLoader(draco);
  }
  return _loader;
}

// v2.16 轮名分词统一入口：先按驼峰边界插空格，再按"非字母"切分。
// 背景：轮组收集靠 token 精确比较（防 'trim'→'rim'、'steering_wheel'→'wheel' 误伤），
// 但新车型命名是驼峰/数字前缀 —— 概念车 'WheelFrontLRim' 会被切成整串 'wheelfrontlrim'、
// SU7/G63 的父节点 '3DWheel Front L' 会切出 'dwheel'，与 'wheel'/'rim' 比较永不为真，
// 轮子整组漏收集（轮子不滚、卡钳不动，外观像"轮子是贴图"）。
// 规则：①([A-Z])([A-Z][a-z]) → 拆缩写+词（3DWheel→3D Wheel）②([a-z0-9])([A-Z]) → 拆驼峰。
// 全小写旧名（ferrari/tesla/porsche）分词结果不变，无回归风险。
function splitTokens(s) {
  return (s || '')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/);
}

// 归一化：车长 4.3m、最长轴对齐 Z、原点落在车底中心
// opts.flip=true 表示原模型车头朝 -Z（ferrari），需绕 Y 转 180°；车头朝 +Z 的模型（tesla）传 false
// opts.skipBounds：mesh 名单 —— 排除出包围盒计算（隐藏反壳会把边界撑大，导致缩放/居中失真）
export function loadCarTemplate(url = 'models/ferrari.glb', onProgress = null, opts = {}) {
  const flip = opts.flip !== false;      // 默认翻 180°（兼容 ferrari.glb）
  const skipBounds = new Set(opts.skipBounds || []);
  // v2.23.1 网络重试：手机并发拉 11+ 个 GLB 时静态服务器偶发拒接（backlog 溢出），
  // 全部失败会整库回退程序化兜底车。这里对单文件最多重试 2 次（间隔 400ms）。
  const attempt = (n, resolve, reject) => {
    getLoader().load(url, (gltf) => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      // 简化模型可能缺法线（减面管线丢弃 NORMAL）：重算平滑法线
      root.traverse((o) => {
        if (o.isMesh && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      });
      // 排除名单：临时隐藏再算包围盒
      const hidden = [];
      if (skipBounds.size) root.traverse((o) => {
        if (o.isMesh && skipBounds.has(o.name)) { o.visible = false; hidden.push(o); }
      });
      const box = new THREE.Box3().setFromObject(root);
      hidden.forEach((o) => { o.visible = true; });
      const size = box.getSize(new THREE.Vector3());
      const scale = 4.3 / Math.max(size.x, size.z);
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      if (size.x > size.z) root.rotation.y = Math.PI / 2; // 车长转到 Z 轴
      if (flip) root.rotation.y += Math.PI; // 模型车头朝 -Z，翻转到 +Z 与前进方向一致
      root.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(root);
      const center = box2.getCenter(new THREE.Vector3());
      const holder = new THREE.Group();
      root.position.set(-center.x, -box2.min.y, -center.z);
      holder.add(root);
      // 轮子烘焙到车体空间：轮 mesh 的父节点可能带旋转/平移（gltf-transform 管线
      // 重排变换的残留），rotation.x 绕"父旋转后的歪轴"滚 → 轮子横过来/左右转。
      // 把顶点用完整世界矩阵烘平、mesh 清空自身变换后挂到 holder 直下 ——
      // 从此轮 mesh 的 X/Y/Z 轴 = 车体轴：rotation.x 绕车宽轴滚、rotation.y 转向。
      // 顺带完成轮心迁移：几何原点落在轮心上（顶点绝对坐标的模型 rotation.x 会
      // 绕车底原点转、轮子甩出）；ferrari 等原点已在轮心的模型烘焙后不变，无损。
      // ⚠️ 同一轮的所有部件（轮毂/轮胎/刹车盘）必须共用同一个轮心 —— 各自用包围盒
      // 中心会绕不同轴转，行驶中轮子部件"里外错动"。轮心取该轮组所有件的联合包围盒中心
      // （若组内有橡胶轮胎件，则以轮胎中心为准：轮胎是几何对称主体，最可靠）。
      holder.updateMatrixWorld(true);
      {
        const V3 = THREE.Vector3;
        const wheelMeshes = [];
        // v2.13.1 与 createCarFromTemplate 同规：token 精确匹配 + steering 一律排除。
        // 旧裸 includes 命中 'steering_wheel' 父节点 → 方向盘内饰件（yellow_trim 等）
        // 被烘平改名收进轮组，z 靠前挤进前二 → 右前轮丢转向
        const tok = splitTokens; // 驼峰感知（v2.16，见 splitTokens 注释）
        const isW = (s) => tok(s).some((t) => t === 'wheel' || t === 'rim' || t === 'tyre' || t === 'tire');
        const extraRe = opts.wheelCollect || null; // v2.16.1 收集级覆盖：tesla_m3 的 wheels_/hub_ 复数命名 token 匹配不上
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const n = o.name || '';
          const pn = (o.parent && o.parent.name) || '';
          if ((n + ' ' + pn).toLowerCase().includes('steering')) return;
          // v2.20 排除踏板/侧 sill 饰条（YU7 'carWheelLogoBase_ScuffPlate' 命中 wheel token
          // 但位于车体中部，收进来会自转）
          if (/scuff|sill/i.test(n + ' ' + pn)) return;
          // v2.20 排除高位件（尾门备胎 y≈0.96，实车轮件几何中心 y≤0.75；判据用归一化后的
          // 模板空间 bbox 中心 y>0.85 —— 概念车轮顶件 ~0.75 安全，尾门备胎必被排除）
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const cy = o.geometry.boundingBox.getCenter(new V3()).applyMatrix4(o.matrixWorld).y;
          if (cy > 0.85) return;
          if (isW(n) || isW(pn) || (extraRe && extraRe.test(n + ' ' + pn))) wheelMeshes.push(o);
        });
        // 按世界位置分组（同轮部件中心相距 <0.35m）
        const _gc = new V3();
        const groups = [];
        for (const m of wheelMeshes) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          const c = m.geometry.boundingBox.getCenter(new V3()).applyMatrix4(m.matrixWorld);
          const g = groups.find((grp) => grp.box.getCenter(_gc).distanceTo(c) < 0.35);
          if (g) { g.meshes.push(m); g.box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
          else groups.push({ meshes: [m], box: m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld) });
        }
        // v2.16 二次合并同轮：G63 这类模型把轮辋拆成十几个辐条小件（每件 24 顶点），
        // 单件 bbox 中心互距可达 0.4m，首轮 0.35m 聚类仍把"一轮"拆成多组 →
        // 游戏端视作多个轮子：转向/滚动错乱、卡钳跟转。轮径 ≈0.8m、轮间最小距 ≥1.2m，
        // 故组中心相距 <0.6m 一律判同一轮（合并 bbox 后继续参与后续合并）。
        for (let i = 0; i < groups.length; i++) {
          for (let j = i + 1; j < groups.length; j++) {
            if (groups[i].box.getCenter(_gc).distanceTo(groups[j].box.getCenter(new V3())) < 0.6) {
              for (const m of groups[j].meshes) groups[i].meshes.push(m);
              groups[i].box.union(groups[j].box);
              groups.splice(j, 1);
              j--;
            }
          }
        }
        for (const g of groups) {
          // 轮心：优先橡胶轮胎件中心（对称主体），否则联合包围盒中心
          let hub = null;
          for (const m of g.meshes) {
            const mn = (Array.isArray(m.material) ? m.material[0]?.name : m.material?.name || '').toLowerCase();
            if (mn.includes('rubber') || mn.includes('tyre') || mn.includes('tire') || (m.name || '').toLowerCase().includes('tire')) {
              hub = m.geometry.boundingBox.getCenter(new V3()).applyMatrix4(m.matrixWorld);
              break;
            }
          }
          if (!hub) hub = g.box.getCenter(new V3());
          for (const m of g.meshes) {
            // 顶点烘平到 holder 空间（吸收父链全部变换）+ 平移轮心到原点
            m.geometry.applyMatrix4(m.matrixWorld);
            m.geometry.translate(-hub.x, -hub.y, -hub.z);
            // mesh 挂 holder 直下：position = 轮心（顶点已以轮心为原点），旋转清零
            m.position.copy(hub);
            m.quaternion.set(0, 0, 0, 1);
            m.scale.set(1, 1, 1);
            m.rotation.order = 'YXZ'; // 转向(y)外层、滚动(x)内层，避免 Euler XYZ 交叉带歪轮轴
            // 摘出原层级后原父名（rim1_19/tyre1_23 等）丢失 —— 把轮词补进 mesh 名，
            // 保证 createCarFromTemplate 的轮子收集仍能命中
            if (!/[ _](wheel|rim|tyre|tire)([^a-z]|$)/i.test(m.name)) m.name += '_wheel';
            holder.add(m);            // 直接挂接（不用 attach——attach 会"保持世界变换"
                                      // 把原父节点的旋转补写回 mesh 造成双重变换歪轴）
          }
        }
      }
      holder.updateMatrixWorld(true);
      resolve(holder);
    }, onProgress || undefined, (err) => {
      // 拒接/断流：退避重试（服务器 backlog 溢出是毫秒级瞬态，间隔 400ms 基本必成）
      if (n > 0) {
        console.warn(`[car] GLB 拉取失败，400ms 后重试（剩 ${n} 次）: ${url}`);
        setTimeout(() => attempt(n - 1, resolve, reject), 400);
      } else reject(err);
    });
  };
  return new Promise((resolve, reject) => attempt(2, resolve, reject));
}

// 克隆模板并按名字换材质（车身漆/玻璃/轮毂）
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x18273a, metalness: 0.1, roughness: 0.05,
  transparent: true, opacity: 0.85, envMapIntensity: 2.4,
});
const rimMat = new THREE.MeshStandardMaterial({ color: 0xd6d9dd, metalness: 1.0, roughness: 0.22 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x22252a, metalness: 0.6, roughness: 0.45 });

export function createCarFromTemplate(template, colorHex, wheelOpts = null) {
  const group = template.clone(true);
  // v2.31 亮度补偿：ACES 色调映射 + 背光/阴影下深色漆会被压得很暗（用户实测 YU7 松岭绿
  // 在实机上发黑 RGB(19,34,15)）。按 HSL 只提明度（色相不变、饱和微增），黑车仍黑。
  const paintColor = new THREE.Color(colorHex);
  {
    const hsl = { h: 0, s: 0, l: 0 };
    paintColor.getHSL(hsl);
    paintColor.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), Math.min(0.9, hsl.l * 1.18 + 0.02));
  }
  const paint = new THREE.MeshPhysicalMaterial({
    // v2.31 车漆修正：旧配方 metalness 0.75 会让漫反射几乎归零（金属只有镜面反射），
    // 深色漆只剩天空反射 → 整台车发黑。改成与程序化车模 paintMat 一致的
    // "介电底漆 + 清漆"：底色漆金属度 0.15 保住饱和度与明度，清漆层负责天空反射高光。
    color: paintColor, metalness: 0.15, roughness: 0.30,
    clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.35,
  });
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const n = (o.name || '').toLowerCase();
    const mn = (Array.isArray(o.material) ? o.material[0]?.name : o.material?.name || '').toLowerCase();
    // 车漆匹配：'blue' 是 ferrari 的第二块喷漆面板；'paint' 是 tesla/g63 的 car_paint；
    // 'body'（v2.16.1 加材质名）：BMW M4 网格名全是 Object_*，车漆在材质 Meshesbody151Mtl 上
    if (n.includes('body') || n === 'blue' || mn.includes('paint') || mn.includes('body')) o.material = paint;
    // 玻璃匹配：ferrari 按网格名，tesla 按材质名 'windows'
    else if (n.includes('glass') || mn.includes('window') || mn.includes('glass')) o.material = glassMat;
    else if (n.includes('rim') || n.includes('trim')) o.material = rimMat;
  });
  // 轮子收集（两层结构：wheels = 每轮一组）：
  // 1) 名字 token 精确匹配 wheel/rim/tyre/tire（裸 includes 会误伤 'trim'→'rim'、
  //    'steering_wheel'→'wheel' 方向盘）；名字或父节点名含 steering 的一律排除。
  // 2) ferrari 每轮 7 个部件、tesla 2 个、porsche 4 个 —— 按轮心位置聚成 4 组，
  //    组内 mesh 一起滚动；组按 z 从大到小排（车头 +Z），前 2 组即前轮（转向用）。
  const tokens = splitTokens; // 驼峰感知（v2.16）：WheelFrontLRim 也能命中 wheel/rim
  const isWheelWord = (s) => tokens(s).some((t) => t === 'wheel' || t === 'rim' || t === 'tyre' || t === 'tire');
  const extraRe = (wheelOpts && wheelOpts.wheelCollect) || null; // v2.16.1 收集级覆盖（与 loadCarTemplate opts.wheelCollect 同规）
  const _vv = new THREE.Vector3(); // v2.20 高位件排除复用的临时向量
  // v2.20 归零前移到收集之前：高位件排除需要矩阵最新（否则 car 位置残留会污染 y 判定）
  group.rotation.set(0, 0, 0);
  group.position.set(0, 0, 0);
  group.updateMatrixWorld(true);
  const raw = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name || '';
    const pn = (o.parent && o.parent.name) || '';
    if ((n + ' ' + pn).toLowerCase().includes('steering')) return;
    // v2.20 同 loadCarTemplate：踏板饰条 + 高位件（尾门备胎）排除
    if (/scuff|sill/i.test(n + ' ' + pn)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox.getCenter(_vv).applyMatrix4(o.matrixWorld).y > 0.85) return;
    if (isWheelWord(n) || isWheelWord(pn) || (extraRe && extraRe.test(n + ' ' + pn))) raw.push(o);
  });
  // 聚组成轮：用几何世界中心聚类（m.position 各模型含义不一：ferrari=0、
  // tesla=父系补偿值，直接比较会错误聚组）；同轮部件中心相距 <0.2m
  const _wc = new THREE.Vector3();
  const worldCenter = (m) => {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    return m.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(m.matrixWorld);
  };
  const groups = [];
  for (const m of raw) {
    const c = worldCenter(m);
    const g = groups.find((grp) => grp.center.distanceTo(c) < 0.2);
    if (g) { g.meshes.push(m); }
    else groups.push({ meshes: [m], center: c });
  }
  // 组中心 = 组内所有件 bbox 中心的均值（首件可能是卡钳，单件中心会把 hub 带偏）
  // v2.16 二次合并同轮（与 loadCarTemplate 同规）：辐条式轮辋的单件中心互相分散，
  // 0.2m 一次聚类会拆成多组 → 组数变 36、转向/滚动分配全错。轮距 ≥1.2m，0.6m 安全。
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (groups[i].center.distanceTo(groups[j].center) < 0.6) {
        groups[i].meshes.push(...groups[j].meshes);
        groups.splice(j, 1);
        j--;
      }
    }
  }
  for (const g of groups) {
    const s = new THREE.Vector3();
    for (const m of g.meshes) s.add(worldCenter(m));
    g.center = s.multiplyScalar(1 / g.meshes.length);
  }
  groups.sort((a, b) => b.center.z - a.center.z);
  for (const g of groups) for (const m of g.meshes) m.userData._centroid = null; // 质心缓存失效
  // 组内分类：滚动件 vs 卡钳类静件。真车刹车卡钳固定于悬挂不随轮转 —— 模型把卡钳
  // 做进轮子组件时，跟着转会在轮子里大幅摆动（用户观感"轮子左右转"）。
  // 判据：顶点均值（质心，弧形件 bbox 中心会被离群顶点拉回轮心附近）：
  //   轴向（车体系 X，轮轴）偏 >0.06m（porsche 卡钳抱在盘侧面）或
  //   轮面内偏 >0.1m（ferrari 卡钳在轮缘上方）→ 静件；名字含 brake/caliper 直接判定。
  const wheels = groups.map((g, i) => {
    const rolling = [], statics = [];
    const centroid = (m) => {
      if (m.userData._centroid) return m.userData._centroid;
      const pos = m.geometry.attributes.position;
      const v = new THREE.Vector3();
      for (let k = 0; k < pos.count; k++) v.add(new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)));
      v.multiplyScalar(1 / Math.max(1, pos.count));
      v.applyMatrix4(m.matrixWorld);
      m.userData._centroid = v;
      return v;
    };
    // hub 初值用面内（y,z）中位数：离群件（内衬/卡钳）拉偏均值会让后续判定全部失准。
    // ⚠️ 单轮判定不迭代——旧版两轮迭代用"滚动件质心均值"重算 hub，质心被辐条顶点分布
    // 拉偏 1-3cm 后，第 2 轮会把第 1 轮已剔的内衬重新判回滚动件（自我回滚），形同虚设
    {
      const ys = g.meshes.map((m) => worldCenter(m).y).sort((a, b) => a - b);
      const zs = g.meshes.map((m) => worldCenter(m).z).sort((a, b) => a - b);
      const xs = g.meshes.map((m) => worldCenter(m).x).sort((a, b) => a - b);
      const mid = (a) => a[(a.length - 1) >> 1];
      var hub = new THREE.Vector3(mid(xs), mid(ys), mid(zs));
    }
    for (const m of g.meshes) {
      const n = (m.name || '').toLowerCase();
      const mn = (Array.isArray(m.material) ? m.material[0]?.name : m.material?.name || '').toLowerCase();
      const toks = tokens(n);
      const pnToks = tokens((m.parent && m.parent.name) || '');
      const isStaticName = n.includes('brake') || n.includes('caliper') || mn.includes('caliper');
      const isRollName = toks.some((t) => t === 'wheel' || t === 'tire' || t === 'tyre' || t === 'rim') ||
        pnToks.some((t) => t === 'wheel' || t === 'rim');
      if (isStaticName) { statics.push(m); continue; }
      // v2.16 车型声明式覆盖（spec.wheelRoll）：有的模型把轮辋拆成大量偏心小件 ——
      // G63 每个轮辋是 14 个 polySurface 辐条/圈片（bbox 中心离轴 0.19~0.33m），概念车轮辋
      // 分 Rim1/Rim2 两个半壳且前左右判反了。这类件在几何上与"轮拱内衬"（911 的 silver 环、
      // bbOff 0.041、必须保持静件）无法安全区分，所以不加通用阈值（会回退 v2.13.2 修复），
      // 改由车型 spec 用正则显式声明"这些件是轮辋，强制滚动"。匹配对象=网格名+材质名。
      if (wheelOpts && wheelOpts.wheelRoll && wheelOpts.wheelRoll.test(n + ' ' + mn)) {
        rolling.push(m);
        continue;
      }
      // v2.13.2 面内偏心优先于命名强制滚动：绕轮轴转的件必须中心落在轮轴线上（面内 y,z≈0），
      // 否则滚动时画圈（911 轮拱内衬 wheel_fr/_fl 名含 wheel 但面内偏 3.5cm，转起来整车前轮"里外晃"）。
      // 判定量用 bbox 中心（弧形件的质心会被离群顶点拉回轮心，bbox 中心才反映几何真实位置）；
      // ferrari 轮胎质心建模偏 0.1 但 bbox 中心在轮轴 → 不误剔
      const wb = worldCenter(m);
      const offPlane = Math.hypot(wb.y - hub.y, wb.z - hub.z);
      if (offPlane > 0.03) { statics.push(m); continue; }
      if (isRollName) { rolling.push(m); continue; }
      const offAxial = Math.abs(wb.x - hub.x);
      if (offAxial > 0.06) statics.push(m);
      else rolling.push(m);
    }
    return { meshes: rolling, static: statics, steer: i < 2 };
  });
  addContactShadow(group);
  return { group, wheels, paint };
}

// 假接触阴影（接地感）：径向渐变软阴影，避免生硬矩形边缘
const _shadowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

function addContactShadow(group) {
  const ao = new THREE.Mesh(
    new THREE.PlaneGeometry(2.7, 5.2),
    new THREE.MeshBasicMaterial({ map: _shadowTex, transparent: true, depthWrite: false })
  );
  ao.rotation.x = -Math.PI / 2;
  ao.position.y = 0.045;
  ao.renderOrder = 1;
  group.add(ao);
}
// ---- 程序化兜底车（GLB 加载失败时用）：由 cars.js 轮廓车工厂提供 ----

// ---- 玩家车：街机物理（参数来自 spec：极速/加速/刹车/操控）----
export class PlayerCar {
  constructor(spec, template = null) {
    const built = template ? createCarFromTemplate(template, spec.color, spec) : buildCarModel(spec);
    this.group = built.group;
    // 轮子结构归一化（同 AICar：程序化兜底车是裸 Mesh）
    this.wheels = (built.wheels || []).map((w, i) =>
      w && w.meshes ? w : { meshes: [w], steer: i < 2 });
    this.paint = built.paint;
    this.spec = spec;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.travelYaw = 0;    // v2.30 实际运动方向（滞后于车头 → 侧滑/惯性）
    this.slip = 0;         // v2.30 滑移角 = yaw - travelYaw（rad）
    this.speed = 0;        // m/s，负值=倒车
    this.driftYaw = 0;     // 甩尾视觉偏航
    this.steerSm = 0;      // 平滑后的转向输入
    this.throttleSm = 0;   // 平滑后的油门
    this.hint = -1;        // 赛道最近样条提示
    this.trackT = 0;       // 归一化赛道进度 0..1
    this.total = 0;        // 总进度（圈数 + t），用于排名
    this.offroad = false;
  }

  // 换车：重建车模（保留位置朝向），更新物理 spec
  applySpec(spec, template = null) {
    const built = template ? createCarFromTemplate(template, spec.color, spec) : buildCarModel(spec);
    const old = this.group;
    const parent = old.parent; // ⚠️ 先存父引用：remove(old) 会把 old.parent 置 null
    this.group = built.group;
    this.group.position.copy(old.position);
    this.group.rotation.copy(old.rotation);
    if (parent) {
      parent.remove(old);
      parent.add(this.group);
    }
    this.wheels = (built.wheels || []).map((w, i) =>
      w && w.meshes ? w : { meshes: [w], steer: i < 2 });
    this.paint = built.paint;
    this.spec = spec;
  }

  reset(pos, yaw) {
    this.pos.copy(pos); this.yaw = yaw; this.speed = 0;
    this.travelYaw = yaw; this.slip = 0;
    this.driftYaw = 0; this.total = 0;
    this.syncMesh();
  }

  // ctrl: {throttle, brake, steer, handbrake}; groundY: 当前地面高度（桥面 1.2 / 平地 0）
  update(dt, ctrl, track, groundY = 0) {
    const off = track.isOffroad(this.pos, this.hint);
    this.hint = off.hint;
    this.offroad = off.off;
    // ★ 差异化物理：极速/加速/刹车/操控全部来自 spec
    // ★ v2.20 越野分级：spec.offroad（0=纯跑车 → 1=越野王）决定草地/土路掉速；
    //    路面材质由 world.surfaceAt 提供：null(草地/野地) 全额越野、'dirt'(土路) 半额、'pave' 无惩罚
    // ★ 湿滑（weather.js 提供 this.wet 0..1）：雨天刹车变软、转向变钝、极速略降
    const S = this.spec;
    const wet = this.wet || 0;
    const orate = S.offroad ?? 0.25;               // 未声明评级的车按普通轿车处理
    const surf = off.off ? 'grass' : (off.surf || 'pave');
    this.surf = surf;
    const surfF = surf === 'grass' ? 1 : (surf === 'dirt' ? 0.45 : 0);
    const topF = 1 - surfF * (0.55 - 0.38 * orate); // 草地：跑车 ×0.45 / 越野王 ×0.83；土路 ×0.75~0.92
    const accF = 1 - surfF * (0.50 - 0.42 * orate); // 草地：跑车 ×0.50 / 越野王 ×0.92
    const MAX = S.topSpeed * topF * (1 - wet * 0.06);

    // ★ 屏幕方向修正：相机从车尾看向 +Z 时水平轴镜像，
    //   yaw 增大会让车往屏幕"左"跑，所以转向取反才符合直觉。
    // ★ 输入平滑：转向 v2.30 收紧到 dt*9（时间常数 167ms→111ms，更跟手）；油门保持 6
    this.steerSm += (-ctrl.steer - this.steerSm) * Math.min(1, dt * 9);
    this.throttleSm += (ctrl.throttle - this.throttleSm) * Math.min(1, dt * 6);
    const steer = this.steerSm;

    // ================= v2.30 纵向动力量纲重标（手感重做）=================
    // 旧版把 CAR_SPECS 的 accel 26~45 / brake 29~38 直接当 m/s² 消费 = 2.6~4.6g 加速、4.7g 制动
    // （实测 223km/h 刹停只要 41.6m，像撞墙）；旧阻力 0.4·v 在 200km/h 合 2.5g 减速，松油门像踩刹车。
    // 现在 spec 数值继续充当"性能评级"，物理层换算成真实量纲：
    //   加速 ≈ 1.2~1.6g（0-100km/h 约 3s 级）、制动 ≈ 1.5~1.9g（街机宽容 > 真实 1.2g）
    const aAccel = S.accel * 0.40;
    const aBrake = S.brake * 0.50;
    const spdAbs = Math.abs(this.speed);
    if (this.throttleSm > 0.02) {
      // 功率曲线：中后段推力衰减（低速猛、高速缓），极速仍由 CAP 精确封顶
      const vN = Math.min(1, spdAbs / Math.max(1, MAX));
      this.speed += aAccel * (1 - 0.50 * vN * vN) * this.throttleSm * dt * accF;
    }
    if (ctrl.brake) this.speed -= aBrake * dt * (this.speed > 0 ? 1 : 0.5) * (1 - wet * 0.35);
    {
      // 风阻 + 滚阻（双项式）：低速几乎不拖、高速自然衰减；越野滚阻额外增加
      const v = Math.abs(this.speed);
      const drag = 0.02 * v + 0.00045 * v * v + surfF * 0.55;
      this.speed -= Math.sign(this.speed) * drag * dt;
    }
    if (ctrl.handbrake) this.speed -= this.speed * 0.9 * dt;   // 手刹减速（仅键盘）
    if (this.offroad && Math.abs(this.speed) > MAX)
      this.speed -= Math.sign(this.speed) * 40 * dt;
    // 极速封顶：铺装上 spec.topSpeed 精确生效；越野冲进来的速度靠阻尼泄掉（模拟陷进草地）
    const CAP = MAX + (this.offroad ? 8 : 0);
    this.speed = Math.max(-8, Math.min(CAP, this.speed));

    // ================= v2.30 转向：横向抓地上限（核心手感）=================
    // 旧版只按速度收窄转向速率、没有轮胎侧向力上限 → 实测 99km/h 满舵 = 23.5m 转弯半径 / 3.27g，
    // 车像无人机（无质量、无惯性）。现在叠加真实约束 ω ≤ a_lat / v：
    //   抓地 1.04 × 街机宽容 1.25 ≈ 1.3g → 99km/h 最小半径约 60m，223km/h 约 300m
    const spd = Math.abs(this.speed);
    const baseRate = 1.85 * S.grip * Math.min(1, spd / 12) * (1 - 0.40 * Math.min(1, spd / MAX))
      * (1 - wet * 0.22); // 雨天转向变钝
    const latCap = 9.8 * S.grip * 1.25 * (1 - wet * 0.18) * (1 - surfF * 0.40); // 侧向加速度上限 m/s²
    const gripRate = latCap / Math.max(6, spd);   // ω 上限（低速时该值很大 = 不生效）
    // ⚠️ 必须用"实际打舵需求的角速度"判定超限：只看 baseRate 会让直行也判超限，
    //    结果直行被持续拖速（极速被压到 140km/h、松油门 15m/s² 减速的 bug 根因）
    const demand = baseRate * Math.abs(steer);
    const overGrip = demand > gripRate;           // 打舵需求超过轮胎极限 → 推头/侧滑
    const turnRate = Math.min(baseRate, gripRate);
    let turn = steer * turnRate * (this.speed < 0 ? -1 : 1);
    if (ctrl.handbrake) turn *= 1.5;
    this.yaw += turn * dt;

    // ================= v2.30 车身惯性：运动方向滞后于车头 =================
    // 车头（yaw）先转，实际轨迹（travelYaw）按抓地力追上 → 侧滑角 slip + 甩尾视觉。
    // 这是"车有重量"的来源：旧版轨迹 = 车头，任何舵量都瞬间变道。
    let dTravel = this.yaw - this.travelYaw;
    while (dTravel > Math.PI) dTravel -= Math.PI * 2;
    while (dTravel < -Math.PI) dTravel += Math.PI * 2;
    let alignRate = (overGrip ? 4.2 : 9.0) * (1 - surfF * 0.45) * (1 - wet * 0.25);
    if (ctrl.handbrake) alignRate *= 0.55;        // 手刹：抓地力骤降（真漂移）
    this.travelYaw += dTravel * Math.min(1, dt * alignRate);
    this.slip = dTravel;                          // 滑移角（rad）供响胎/相机/侧倾消费

    this.driftYaw += (((ctrl.handbrake && spd > 14 ? steer * 0.35 : 0) + this.slip * 0.55)
      - this.driftYaw) * Math.min(1, dt * 5);
    // 超出抓地极限才耗散动能（按打舵超限量平方，走线正常/直行不拖速）
    if (overGrip && spd > 8) {
      const ex = Math.min(1, (demand - gripRate) / Math.max(0.01, demand));
      this.speed -= this.speed * ex * ex * 0.35 * Math.abs(steer) * dt;
    }

    this.pos.x += Math.sin(this.travelYaw) * this.speed * dt;
    this.pos.z += Math.cos(this.travelYaw) * this.speed * dt;
    // 桥面/地面高度平滑过渡
    this.pos.y += (groundY - this.pos.y) * Math.min(1, dt * 8);
    // 世界边界（v2.11 放宽到 2000：北面山体/越野爬坡需要余量）
    const R = 2000;
    if (this.pos.length() > R) { this.pos.setLength(R); this.speed *= 0.5; }

    // ★ 护栏碰撞：仅比赛模式（护栏可见）且贴近路缘过渡带时生效
    this.wallHit = 0;
    {
      const railsOn = track.railGroup && track.railGroup.visible;
      const s = track.samples[this.hint];
      const onStrip = track.distToStrip(this.pos.x, this.pos.z) <= track.strip.width / 2 + 0.6;
      const lat = (this.pos.x - s.pos.x) * s.side.x + (this.pos.z - s.pos.z) * s.side.z;
      const LIMIT = HALF_WIDTH + 1.0;
      const inBand = Math.abs(lat) > LIMIT && Math.abs(lat) < LIMIT + 6;
      if (railsOn && !onStrip && inBand) {
        const push = (Math.abs(lat) - LIMIT) * Math.sign(lat);
        this.pos.addScaledVector(s.side, -push);
        // ★ 剐蹭强度按撞击角加权：垂直撞护栏重罚，平行蹭护栏只轻擦
        const tanA = Math.atan2(s.tan.x, s.tan.z);
        const hitAngle = Math.abs(Math.sin(this.yaw - tanA));
        this.wallHit = Math.min(1, (Math.abs(this.speed) / 30) * hitAngle);
        this.speed *= 1 - 0.25 * hitAngle; // 单帧最多 -25%（垂直时）
      }
    }

    // 赛道进度
    const { i } = track.nearestSample(this.pos, this.hint);
    const prevT = this.trackT;
    this.trackT = i / track.samples.length;
    if (this.trackT < 0.2 && prevT > 0.8) this.total += 1 - prevT + this.trackT; // 过起点
    else this.total += this.trackT - prevT;
    this.hint = i;

    // 车轮滚动 + 前轮转向（wheels 为每轮一组：组内所有部件一起滚/转）
    // 滚动方向：车头 +Z 前进 → 轮角速度沿 +X（ω=v/R>0），rotation.x 必须递增
    // （-= 会让轮顶向车尾、观感倒车——v2.9.1 用户实测确认）
    // v2.13.1 卡钳静件转向跟随：真实卡钳固定在转向节上——随转向转、不随轮滚。
    // 静件只滚不转向会让 911 黄卡钳在打舵时戳出轮辐外（Tesla 无静件从未暴露）
    const spin = this.speed * dt / 0.37;
    for (const w of this.wheels) {
      for (const m of w.meshes) {
        m.rotation.x += spin;
        if (w.steer) m.rotation.y = steer * 0.4;
      }
      if (w.steer && w.static) for (const m of w.static) {
        // v2.13.2 只跟随卡钳/刹车件（随转向节）；轮拱内衬等静件贴车身不随转向
        const n = (m.name || '').toLowerCase();
        if (n.includes('caliper') || n.includes('brake')) m.rotation.y = steer * 0.4;
      }
    }
    this.syncMesh();
    const braking = ctrl.brake && spd > 20;
    // v2.30 侧滑响胎：滑移角超过 ~6° 且在中高速 → 轮胎尖叫/胎痕（推头与漂移都有反馈）
    const slipping = Math.abs(this.slip) > 0.10 && spd > 12;
    return {
      dust: (this.offroad || this.surf === 'dirt') && spd > 4,
      drifting: (ctrl.handbrake && spd > 12) || slipping,
      skid: (ctrl.handbrake && spd > 12) || braking || slipping,
      wallHit: this.wallHit,
    };
  }

  syncMesh() {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw + this.driftYaw;
    this.group.rotation.z = -this.driftYaw * 0.6; // 甩尾侧倾
  }
}

// ---- AI 车：起步反应 + 加减速 + 弯道判弯 + 橡皮筋追赶 ----
// env = 任何有 {curve, length} 的路线（环道 / 高速 / 城市 / 乡道），dir=±1 双向行驶
export class AICar {
  constructor(color, lane, baseSpeed, template = null, route = null, dir = 1, startT = 0) {
    const built = template ? createCarFromTemplate(template, color) : buildCarModel({ id: 'ferrari', color });
    this.group = built.group;
    // 轮子结构归一化：真车模是 {meshes,steer} 组，程序化兜底车是裸 Mesh
    // （不归一会让 placeOn/update 的 w.meshes 遍历在无 GLB 环境直接崩帧）
    this.wheels = (built.wheels || []).map((w, i) =>
      w && w.meshes ? w : { meshes: [w], steer: i < 2 });
    this.color = color;          // 供小地图着色
    this.lane = lane;
    this.baseSpeed = baseSpeed;
    this.speed = 0;              // 当前速度（m/s），真实加速/减速逼近目标
    this.reaction = 0.4 + Math.random() * 0.7; // 起步反应时间（车手差异）
    this.route = route;          // 巡航路线（NPC 车流用），比赛车为 null 走环道
    this.dir = dir;              // 行驶方向：1 正向，-1 逆向
    this.total = 0;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this._side = new THREE.Vector3();
    // v2.19：startT 相位（0..1）——车流分散到路线各处，不再全堆在路线起点
    if (route) {
      this.total = (((startT % 1) + 1) % 1) * route.length;
      this.placeOn(route, 0);          // 出生即落到路面上
    }
  }

  reset(track) {
    this.total = 0;
    this.speed = 0;
    this.reaction = 0.4 + Math.random() * 0.7;
    this.place(track);
  }

  // 比赛车（环道，含橡皮筋）
  update(dt, track, playerTotal) {
    if (this.reaction > 0) {
      this.reaction -= dt;
      this.place(track, 0);
      return;
    }
    const gap = playerTotal - this.total;
    const rubber = Math.max(-4, Math.min(6, gap * 20));

    const t = ((this.total / track.length) % 1 + 1) % 1;
    const tan1 = track.curve.getTangentAt(t);
    const tan2 = track.curve.getTangentAt((t + 0.012) % 1);
    const ang = tan1.angleTo(tan2);
    const corner = Math.max(0.45, 1 - ang * 14);
    const target = Math.max(8, (this.baseSpeed + rubber) * corner);

    const accel = 11, decel = 22;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);

    this.total += this.speed * dt;
    this.place(track, this.speed * dt / 0.37);
  }

  // NPC 车流（固定路线巡航；hold=true = 红灯停车）
  updateTraffic(dt, env, hold = false) {
    if (this.reaction > 0) {
      this.reaction -= dt;
      this.placeOn(env, 0);
      return;
    }
    const target = hold ? 0 : this.baseSpeed;
    const accel = 7, decel = 16;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);
    if (hold && this.speed < 0.05) { this.placeOn(env, 0); return; }
    this.total += this.speed * dt * this.dir;
    this.placeOn(env, Math.abs(this.speed) * dt / 0.37);
  }

  place(track, spin = 0) {
    const t = ((this.total / track.length) % 1 + 1) % 1;
    const p = track.curve.getPointAt(t);
    const tan = track.curve.getTangentAt(t).setY(0).normalize();
    this._side.set(tan.z, 0, -tan.x);
    this.pos.copy(p).addScaledVector(this._side, this.lane);
    this.pos.y = p.y;
    this.yaw = Math.atan2(tan.x, tan.z);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    for (const w of this.wheels) for (const m of w.meshes) m.rotation.x += spin;
  }

  placeOn(env, spin = 0) {
    const len = env.length;
    const t = ((this.total / len) % 1 + 1) % 1;
    const p = env.curve.getPointAt(t);
    const tan = env.curve.getTangentAt(t).setY(0).normalize();
    this._side.set(tan.z, 0, -tan.x).multiplyScalar(this.dir);
    this.pos.copy(p).addScaledVector(this._side, this.lane);
    this.pos.y = p.y;
    this.yaw = Math.atan2(tan.x * this.dir, tan.z * this.dir);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    for (const w of this.wheels) for (const m of w.meshes) m.rotation.x += spin;
  }

  // ---- v2.32 冲刺/越野赛（单向路线）：不回绕，冲线后停住 ----
  resetSprint(env, lane = this.lane) {
    this.lane = lane;
    this.total = 0;
    this.speed = 0;
    this.finished = false;
    this.finishTime = null;
    this.reaction = 0.4 + Math.random() * 0.7;
    this.placeRoute(env);
  }

  placeRoute(env, spin = 0) {
    const t = Math.max(0, Math.min(0.9999, this.total / env.length));
    const p = env.curve.getPointAt(t);
    const tan = env.curve.getTangentAt(t).setY(0).normalize();
    this._side.set(tan.z, 0, -tan.x);
    this.pos.copy(p).addScaledVector(this._side, this.lane);
    this.pos.y = p.y;
    this.yaw = Math.atan2(tan.x, tan.z);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    for (const w of this.wheels) for (const m of w.meshes) m.rotation.x += spin;
  }

  // 单向路线版比赛车：橡皮筋 + 弯道判弯同环道，但 total 沿曲线长度单调增长
  updateSprint(dt, env, playerTotal) {
    if (this.finished) { this.placeRoute(env); return; }
    if (this.reaction > 0) { this.reaction -= dt; this.placeRoute(env); return; }
    const gap = playerTotal - this.total;
    const rubber = Math.max(-4, Math.min(6, gap * 20));
    // 前方 0.012 曲线长的切向夹角判弯（t 钳在 [0,1) 防终点外取切线）
    const t0 = Math.min(0.999, this.total / env.length);
    const t1 = Math.min(1, t0 + 0.012);
    const ang = env.curve.getTangentAt(t0).angleTo(env.curve.getTangentAt(t1));
    const corner = Math.max(0.45, 1 - ang * 14);
    const target = Math.max(8, (this.baseSpeed + rubber) * corner);
    const accel = 11, decel = 22;
    if (this.speed < target) this.speed = Math.min(target, this.speed + accel * dt);
    else this.speed = Math.max(target, this.speed - decel * dt);
    this.total = Math.min(env.length, this.total + this.speed * dt);
    if (this.total >= env.length - 0.5) this.finished = true;
    this.placeRoute(env, this.speed * dt / 0.37);
  }
}
