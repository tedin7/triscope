import type { Element } from '@triscope/core';
import * as THREE from 'three/webgpu';

/**
 * Example triscope element: a rotating PBR cube with three exposed knobs.
 * Replace this with your own element(s).
 */
interface CubeUserData {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  spin: number;
}

export const cube: Element = {
  name: 'cube',
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },

  mount: ({ parent, ctx }) => {
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(2, 3, 1);
    parent.add(sun);
    const amb = new THREE.AmbientLight(0xb0c0ce, 0.4);
    parent.add(amb);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: '#d8a85a',
      roughness: 0.4,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    parent.add(mesh);

    const userData: CubeUserData = { mesh, material: mat, spin: 0.8 };

    const tick = () => {
      mesh.rotation.y += ctx.dt.value * userData.spin;
      mesh.rotation.x = Math.sin(ctx.time.value * 0.3) * 0.2;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    return {
      root: mesh,
      userData: userData as unknown as Record<string, unknown>,
      dispose: () => {
        parent.remove(mesh);
        parent.remove(sun);
        parent.remove(amb);
        geo.dispose();
        mat.dispose();
      },
    };
  },

  cameras: {
    front: { position: [0, 0, 3], target: [0, 0, 0] },
    back: { position: [0, 0, -3], target: [0, 0, 0] },
    left: { position: [-3, 0, 0], target: [0, 0, 0] },
    right: { position: [3, 0, 0], target: [0, 0, 0] },
    top: { position: [0, 3, 0], target: [0, 0, 0] },
    'three-quarter': { position: [2, 2, 2], target: [0, 0, 0] },
  },

  knobs: {
    color: { type: 'color', default: '#d8a85a', label: 'color' },
    roughness: { type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, label: 'roughness' },
    metalness: { type: 'number', min: 0, max: 1, step: 0.01, default: 0.1, label: 'metalness' },
    spin: { type: 'number', min: -3, max: 3, step: 0.05, default: 0.8, label: 'spin (rad/s)' },
  },

  onKnob: (handle, key, value) => {
    const u = handle.userData as unknown as CubeUserData;
    if (key === 'color') u.material.color.set(String(value));
    else if (key === 'roughness') u.material.roughness = Number(value);
    else if (key === 'metalness') u.material.metalness = Number(value);
    else if (key === 'spin') u.spin = Number(value);
  },

  telemetry: (handle) => {
    const u = handle.userData as unknown as CubeUserData;
    return {
      rotationY: u.mesh.rotation.y,
      color: '#' + u.material.color.getHexString(),
      roughness: u.material.roughness,
      metalness: u.material.metalness,
      spin: u.spin,
    };
  },
};
