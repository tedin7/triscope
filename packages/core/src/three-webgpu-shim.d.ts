// Minimal ambient declarations for `three` and `three/webgpu`.
// Three.js does not ship .d.ts files for these entry points as of v0.176.x.
// Class declarations below give us both value and type bindings for
// `import * as THREE from 'three/webgpu'`. Members are typed `any` —
// downstream user code should rely on its own three.js typings if it wants
// stricter types.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'three/webgpu' {
  export class WebGPURenderer {
    constructor(opts?: any);
    domElement: HTMLCanvasElement;
    autoClear: boolean;
    init(): Promise<void>;
    setSize(w: number, h: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color: number, alpha?: number): void;
    setViewport(x: number, y: number, w: number, h: number): void;
    setScissor(x: number, y: number, w: number, h: number): void;
    setScissorTest(enable: boolean): void;
    clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
    render(scene: any, camera: any): void;
    getPixelRatio(): number;
    dispose(): void;
    [key: string]: any;
  }
  export class Scene extends Object3D {
    background: any;
    environment: any;
  }
  export class PerspectiveCamera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    near: number;
    far: number;
    position: Vector3;
    quaternion: Quaternion;
    lookAt(x: number | Vector3, y?: number, z?: number): void;
    updateProjectionMatrix(): void;
    [key: string]: any;
  }
  export class Object3D {
    position: Vector3;
    quaternion: Quaternion;
    visible: boolean;
    userData: Record<string, any>;
    name: string;
    parent: Object3D | null;
    children: Object3D[];
    add(...obj: Object3D[]): this;
    remove(...obj: Object3D[]): this;
    traverse(cb: (obj: Object3D) => void): void;
    [key: string]: any;
  }
  export class Group extends Object3D {}
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    clone(): Vector3;
    length(): number;
    normalize(): this;
    multiplyScalar(s: number): this;
    applyQuaternion(q: Quaternion): this;
    toArray(): number[];
  }
  export class Quaternion {
    [key: string]: any;
  }
  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    set(x: number, y: number): this;
  }
  export class Matrix4 {
    copy(m: Matrix4): this;
    [key: string]: any;
  }
  export class BufferGeometry {
    type: string;
    index: { count: number } | null;
    attributes: any;
    [key: string]: any;
  }
  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: any);
    geometry: BufferGeometry;
    material: any;
    isMesh: boolean;
    matrix: Matrix4;
    matrixAutoUpdate: boolean;
    matrixWorld: Matrix4;
    renderOrder: number;
    frustumCulled: boolean;
    updateMatrixWorld(force?: boolean): void;
    raycast: (raycaster: Raycaster, intersects: any[]) => void;
  }
  export class Raycaster {
    setFromCamera(coords: Vector2, camera: any): void;
    intersectObjects(objects: Object3D[], recursive?: boolean): Array<{
      object: Object3D;
      distance: number;
      point: Vector3;
    }>;
  }
  export class MeshBasicNodeMaterial {
    constructor(opts?: any);
  }
  export const MOUSE: { ROTATE: any; PAN: any; DOLLY: any };
  export const TOUCH: { ROTATE: any; PAN: any; DOLLY_PAN: any; DOLLY_ROTATE: any };
  // Catch-all for everything else we don't enumerate.
  const _: any;
  export default _;
}

declare module 'three' {
  export * from 'three/webgpu';
}

declare module 'three/tsl' {
  const _: any;
  export = _;
}
