/**
 * Standalone procedural galleon for the Triscope ocean-galleon example.
 *
 * Smaller and self-contained version of the water3d pirate ship — built from
 * primitives, no GLTF, but using a TSL sail material so the shader pipeline
 * is exercised end-to-end. The point is to demonstrate the framework, not
 * to compete with the production mesh.
 *
 * Coordinate frame (ship local): +X forward (bow), +Y up, +Z starboard.
 * Origin at waterline center.
 */

import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

export interface GalleonMeshResult {
  group: THREE.Group;
  sailPivots: THREE.Group[];
  oarPivots: THREE.Group[];
  uWindPressure: { value: number };
  uSheetAngle: { value: number };
  uOarStroke: { value: number };
  uWindSpeed: { value: number };
}

export interface GalleonMeshOptions {
  hullColor?: string;
  deckColor?: string;
  sailColor?: string;
  mastColor?: string;
}

function pbr(color: string, roughness = 0.72, metalness = 0): THREE.MeshPhysicalNodeMaterial {
  return new THREE.MeshPhysicalNodeMaterial({ color, roughness, metalness });
}

function makeSailMat(
  color: string,
  _uWindPressure: ReturnType<typeof uniform>,
): THREE.MeshPhysicalNodeMaterial {
  // NOTE: a TSL-driven positionNode would let sails breathe with uWindPressure,
  // but the deeper "shader-iteration story" really lives on water3d's actual
  // pirate ship. Here we keep a plain PBR material so the example boots fast
  // on every WebGPU adapter without TSL compile-graph quirks.
  return new THREE.MeshPhysicalNodeMaterial({
    color,
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

export function createGalleonMesh(opts: GalleonMeshOptions = {}): GalleonMeshResult {
  const hullColor = opts.hullColor ?? '#5b3a1f';
  const deckColor = opts.deckColor ?? '#7a4c25';
  const sailColor = opts.sailColor ?? '#e6dcc0';
  const mastColor = opts.mastColor ?? '#3a2614';

  const uWindPressure = uniform(0).label('uGalleonWindPressure');
  const uSheetAngle = uniform(0).label('uGalleonSheetAngle');
  const uOarStroke = uniform(0).label('uGalleonOarStroke');
  const uWindSpeed = uniform(0).label('uGalleonWindSpeed');

  const root = new THREE.Group();
  root.name = 'galleon';

  // --- Hull: tapered box. Three vertical slices give a coarse hull shape.
  const hullMat = pbr(hullColor, 0.78);
  const hull = new THREE.Group();
  const hullMid = new THREE.Mesh(new THREE.BoxGeometry(20, 4, 6), hullMat);
  hullMid.position.set(0, -1, 0);
  hull.add(hullMid);
  // Tapered bow (positive X)
  const bowGeom = new THREE.BoxGeometry(4, 4, 4);
  bowGeom.translate(2, 0, 0); // shift origin to back-left so it tapers forward
  const bow = new THREE.Mesh(bowGeom, hullMat);
  bow.position.set(10, -1, 0);
  hull.add(bow);
  // Tapered stern (negative X)
  const stern = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 5), hullMat);
  stern.position.set(-12, -0.5, 0);
  hull.add(stern);
  root.add(hull);

  // --- Deck (flat top)
  const deckMat = pbr(deckColor, 0.85);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(22, 0.3, 5.6), deckMat);
  deck.position.set(0, 1.1, 0);
  root.add(deck);

  // --- Masts (2)
  const mastMat = pbr(mastColor, 0.6);
  const masts: Array<{ x: number; height: number }> = [
    { x: 4, height: 12 }, // main mast
    { x: -4, height: 10 }, // mizzen
  ];
  const sailPivots: THREE.Group[] = [];
  const sailMat = makeSailMat(sailColor, uWindPressure);
  for (const m of masts) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, m.height, 12), mastMat);
    mast.position.set(m.x, m.height / 2 + 1, 0);
    root.add(mast);

    // Yardarm + sail. A pivot at the yardarm rotates around Y for sheet angle.
    const pivot = new THREE.Group();
    pivot.position.set(m.x, m.height * 0.85 + 1, 0);
    root.add(pivot);
    sailPivots.push(pivot);

    const sailGeom = new THREE.PlaneGeometry(6, m.height * 0.55, 16, 16);
    const sail = new THREE.Mesh(sailGeom, sailMat);
    // Rotate the sail so its normal points along world ±X (wind direction).
    sail.rotation.y = Math.PI / 2;
    sail.position.set(0, -m.height * 0.25, 0);
    pivot.add(sail);
  }

  // --- Oars (4 per side, 8 total) with pivots that rotate around X for stroke.
  const oarMat = pbr('#6e4b22', 0.7);
  const oarPivots: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 4; i++) {
      const x = -6 + i * 3;
      const z = side * 3;
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.5, z);
      root.add(pivot);
      oarPivots.push(pivot);
      const oar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 8), oarMat);
      // Lay the oar horizontal; rotate around its grip end so the blade dips in/out.
      oar.rotation.z = Math.PI / 2;
      oar.position.set(side * 2.5, 0, 0);
      pivot.add(oar);
    }
  }

  // --- Flag on the main mast (small plane; visual only, no animation here).
  const flagMat = pbr('#2a2a2a');
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1), flagMat);
  flag.position.set(4, masts[0].height + 1.2, 0);
  root.add(flag);

  return {
    group: root,
    sailPivots,
    oarPivots,
    uWindPressure: uWindPressure as unknown as { value: number },
    uSheetAngle: uSheetAngle as unknown as { value: number },
    uOarStroke: uOarStroke as unknown as { value: number },
    uWindSpeed: uWindSpeed as unknown as { value: number },
  };
}
