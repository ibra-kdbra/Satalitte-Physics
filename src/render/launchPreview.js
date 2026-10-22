// Drag-to-launch velocity arrow: shaft + head, scaled to the drag length.
import { Group, Mesh, CylinderGeometry, ConeGeometry, SphereGeometry, MeshBasicMaterial, Vector3, Quaternion, Color } from 'three';

export function createLaunchPreview(scene) {
  const color = new Color(1.0, 0.75, 0.25); // below the bloom threshold: readable, not glaring
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false });
  // unit-length shaft/head along +Y with their bases at y = 0
  const shaftGeo = new CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0);
  const headGeo = new ConeGeometry(1, 1, 14).translate(0, 0.5, 0);
  const shaft = new Mesh(shaftGeo, mat);
  const head = new Mesh(headGeo, mat);
  const base = new Mesh(new SphereGeometry(1, 12, 8), mat);
  const group = new Group();
  group.name = 'LaunchPreview';
  group.add(shaft, head, base);
  group.visible = false;
  group.renderOrder = 5;
  scene.add(group);

  const _dir = new Vector3();
  const _q = new Quaternion();
  const _up = new Vector3(0, 1, 0);

  function show(start, end) {
    _dir.subVectors(end, start);
    const len = _dir.length();
    if (len < 1e-9) { group.visible = false; return; }
    _dir.divideScalar(len);
    group.position.copy(start);
    group.quaternion.copy(_q.setFromUnitVectors(_up, _dir));
    const headLen = len * 0.18;
    const w = len * 0.012;
    shaft.scale.set(w, len - headLen, w);
    head.position.y = len - headLen;
    head.scale.set(w * 3.2, headLen, w * 3.2);
    base.scale.setScalar(w * 2.2);
    group.visible = true;
  }

  function hide() { group.visible = false; }

  return { show, hide, object: group };
}
