import type { Vec3 } from '../core/types.js';

/** Returns a stable, opposite direction for a collocated pair of dense nodes. */
export function deterministicPairDirection(first: number, second: number, dimensions: 2 | 3): Vec3 {
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const hash = Math.imul(low + 1, 73856093) ^ Math.imul(high + 1, 19349663);
  const axis = (hash >>> 0) % dimensions;
  const sign = ((hash >>> 2) & 1) === 0 ? 1 : -1;
  const orientation = first <= second ? sign : -sign;
  return {
    x: axis === 0 ? orientation : 0,
    y: axis === 1 ? orientation : 0,
    z: dimensions === 3 && axis === 2 ? orientation : 0
  };
}
