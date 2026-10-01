import { GraphError } from '../../core/errors.js';

export type ThreeModule = Record<string, unknown>;
export type TslModule = Record<string, unknown>;

export interface ThreePlatform {
  readonly THREE: ThreeModule;
  readonly TSL: TslModule;
  readonly capabilities: Readonly<{
    webgpuRenderer: boolean;
    nodeMaterials: boolean;
    raycasting: boolean;
  }>;
}

export interface CreateThreePlatformOptions {
  THREE: ThreeModule;
  TSL: TslModule;
}

/**
 * Captures the application's exact Three/TSL module instances. Nothing in the
 * core resolves Three itself, which prevents duplicate module-instance bugs.
 */
export function createThreePlatform(options: CreateThreePlatformOptions): ThreePlatform {
  if (!options || !isRecord(options.THREE) || !isRecord(options.TSL)) {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'createThreePlatform requires injected THREE and TSL module objects.');
  }
  if (typeof options.THREE.Group !== 'function' || typeof options.THREE.Object3D !== 'function') {
    throw new GraphError('FG_RENDER_PLATFORM_INVALID', 'The injected THREE module must provide Group and Object3D constructors.');
  }
  return Object.freeze({
    THREE: options.THREE,
    TSL: options.TSL,
    capabilities: Object.freeze({
      webgpuRenderer: typeof options.THREE.WebGPURenderer === 'function',
      nodeMaterials: typeof options.THREE.SpriteNodeMaterial === 'function'
        || typeof options.THREE.MeshBasicNodeMaterial === 'function',
      raycasting: typeof options.THREE.Raycaster === 'function'
    })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
