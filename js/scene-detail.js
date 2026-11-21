import * as THREE from 'three';

export function boxBatch(parent, name, material, items, castShadow = false) {
  if (!items.length) return;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), material, items.length);
  const pose = new THREE.Object3D();
  for (const [i, [x,y,z,w,h,d,yaw = 0,roll = 0]] of items.entries()) {
    pose.position.set(x,y,z);
    pose.scale.set(w,h,d);
    pose.rotation.set(0,yaw,roll);
    pose.updateMatrix();
    mesh.setMatrixAt(i,pose.matrix);
  }
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function firCrown() {
  const vertices = [], colors = [], indices = [];
  const rings = [[-.5,.3],[-.41,.92],[-.26,.62],[-.17,.76],[.02,.43],[.10,.51],[.29,.24],[.50,.012]];
  const sides = 9;
  for (let j=0;j<rings.length;j++) for (let i=0;i<sides;i++) {
    const a=i/sides*Math.PI*2, wave=Math.sin(i*5.7+j*2.1);
    const [y,r]=rings[j], radius=r*(1+.18*wave);
    vertices.push(Math.cos(a)*radius,y+wave*r*.045,Math.sin(a)*radius);
    const tint=.71+j*.035+wave*.08;
    colors.push(tint*.98,tint,tint*.88);
    if (j) {
      const v=(j-1)*sides+i, next=(j-1)*sides+(i+1)%sides;
      indices.push(v,v+sides,next,next,v+sides,next+sides);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
