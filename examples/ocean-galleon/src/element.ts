/**
 * Triscope Element for the ocean-galleon example.
 *
 * Implements the @triscope/core Element contract: cameras, knobs, telemetry,
 * motion probes. The mesh is the standalone procedural galleon in
 * ./galleon-mesh.ts — no water3d dependency.
 */

import type { Element } from '@triscope/core';
import * as THREE from 'three/webgpu';
import { createGalleonMesh } from './galleon-mesh.js';

interface GalleonUserData {
  group: THREE.Group;
  uWindPressure: { value: number };
  uSheetAngle: { value: number };
  uOarStroke: { value: number };
  uWindSpeed: { value: number };
  sailPivots: THREE.Group[];
  oarPivots: THREE.Group[];
  triangleCount: number;
  windBase: number;
  windGust: number;
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((obj: any) => {
    const geom = obj.geometry;
    if (!geom) return;
    if (geom.index) total += geom.index.count / 3;
    else if (geom.attributes?.position) total += geom.attributes.position.count / 3;
  });
  return Math.round(total);
}

export const galleonElement: Element = {
  name: 'galleon',
  labUrl: '/',

  bounds: { min: [-15, -3, -4], max: [15, 14, 4] },

  mount: ({ parent, ctx }) => {
    // Local lights so the galleon reads correctly regardless of clear color.
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(0.6, 0.8, 0.4).multiplyScalar(100);
    parent.add(sun);
    const ambient = new THREE.AmbientLight(0xb8ccd6, 0.55);
    parent.add(ambient);

    const mesh = createGalleonMesh({});
    mesh.group.position.set(0, 0, 0);
    parent.add(mesh.group);

    const userData: GalleonUserData = {
      group: mesh.group,
      uWindPressure: mesh.uWindPressure,
      uSheetAngle: mesh.uSheetAngle,
      uOarStroke: mesh.uOarStroke,
      uWindSpeed: mesh.uWindSpeed,
      sailPivots: mesh.sailPivots,
      oarPivots: mesh.oarPivots,
      triangleCount: countTriangles(mesh.group),
      windBase: 0.6,
      windGust: 0.5,
    };

    const handle = {
      root: mesh.group,
      userData: userData as unknown as Record<string, unknown>,
      dispose: () => {
        parent.remove(mesh.group);
        parent.remove(sun);
        parent.remove(ambient);
      },
    };

    // RAF-driven animation: sheet angle, oar stroke, wind gust oscillation.
    const animate = () => {
      const t = ctx.time.value;
      for (let i = 0; i < userData.sailPivots.length; i++) {
        userData.sailPivots[i].rotation.y = userData.uSheetAngle.value;
      }
      for (let i = 0; i < userData.oarPivots.length; i++) {
        userData.oarPivots[i].rotation.x =
          userData.uOarStroke.value * Math.sin(t * 1.4 + i * 0.4) * 0.4;
      }
      // Wind gust oscillation around windBase.
      userData.uWindPressure.value =
        userData.windBase + userData.windGust * Math.sin(t * 0.6) * 0.4;
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);

    return handle;
  },

  cameras: {
    bow: { position: [25, 6, 0], target: [0, 4, 0] },
    stern: { position: [-25, 6, 0], target: [0, 4, 0] },
    starboard: { position: [0, 6, 25], target: [0, 4, 0] },
    port: { position: [0, 6, -25], target: [0, 4, 0] },
    top: { position: [0, 40, 0], target: [0, 0, 0] },
    'three-quarter-front': { position: [18, 12, 18], target: [0, 4, 0] },
    'three-quarter-stern': { position: [-18, 12, 18], target: [0, 4, 0] },
    'deck-close': { position: [4, 10, 0], target: [0, 8, 0], fov: 50 },
  },

  knobs: {
    windPressure: {
      type: 'number',
      min: 0,
      max: 2,
      step: 0.01,
      default: 0.6,
      label: 'wind pressure (steady)',
    },
    windGust: {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      label: 'wind gust (oscillation)',
    },
    sheetAngle: {
      type: 'number',
      min: -1.4,
      max: 1.4,
      step: 0.01,
      default: 0,
      label: 'sheet angle (rad)',
    },
    oarStroke: { type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, label: 'oar stroke' },
    windSpeed: { type: 'number', min: 0, max: 20, step: 0.1, default: 8, label: 'wind speed' },
    yaw: {
      type: 'number',
      min: -Math.PI,
      max: Math.PI,
      step: 0.01,
      default: 0,
      label: 'yaw (rad)',
    },
  },

  onKnob: (handle, key, value) => {
    const u = handle.userData as unknown as GalleonUserData;
    // windPressure also writes the uniform directly so mode='time' captures
    // (which pause RAF) still reflect the new knob immediately.
    if (key === 'windPressure') {
      u.windBase = Number(value);
      u.uWindPressure.value = u.windBase;
    } else if (key === 'windGust') u.windGust = Number(value);
    else if (key === 'sheetAngle') u.uSheetAngle.value = Number(value);
    else if (key === 'oarStroke') u.uOarStroke.value = Number(value);
    else if (key === 'windSpeed') u.uWindSpeed.value = Number(value);
    else if (key === 'yaw') u.group.rotation.y = Number(value);
  },

  telemetry: (handle) => {
    const u = handle.userData as unknown as GalleonUserData;
    return {
      triangles: u.triangleCount,
      uWindPressure: u.uWindPressure.value,
      uSheetAngle: u.uSheetAngle.value,
      uOarStroke: u.uOarStroke.value,
      uWindSpeed: u.uWindSpeed.value,
      yaw: u.group.rotation.y,
      position: u.group.position.toArray(),
    };
  },

  // Motion probes mirror the CPU-observable signals driving the sail TSL
  // shader (sin(t*1.4) wander, sin(t*4.3) flutter, both scaled by
  // uWindPressure). peakToPeak > 0 proves the animation evolved.
  motionProbes: {
    sailWanderEnvelope: (handle, ctx) => {
      const u = handle.userData as unknown as GalleonUserData;
      return u.uWindPressure.value * Math.sin(ctx.time.value * 1.4);
    },
    sailFlutterEnvelope: (handle, ctx) => {
      const u = handle.userData as unknown as GalleonUserData;
      return u.uWindPressure.value * Math.sin(ctx.time.value * 4.3) * 0.18;
    },
    oarStrokeEnvelope: (handle, ctx) => {
      const u = handle.userData as unknown as GalleonUserData;
      return u.uOarStroke.value * Math.sin(ctx.time.value * 1.4);
    },
  },
};
