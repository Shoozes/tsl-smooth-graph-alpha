import type { LayoutSnapshot } from '../core/types.js';

export type SnapshotTransferBuffers = Pick<LayoutSnapshot, 'nodeIndices' | 'positions' | 'velocities'>;

export interface SnapshotTransferLease {
  readonly poolId: number;
  readonly buffers: SnapshotTransferBuffers;
}

interface SnapshotTransferSlot {
  poolId: number;
  buffers: SnapshotTransferBuffers;
  inFlight: boolean;
}

/**
 * Holds a small, explicitly owned set of snapshot buffers for worker transfer.
 * A slot is unavailable until the receiving bridge transfers it back.
 */
export class SnapshotTransferPool {
  private readonly slots = new Map<number, SnapshotTransferSlot>();
  private nextPoolId = 1;
  private readonly maximumSlots: number;

  constructor(maximumSlots = 3) {
    this.maximumSlots = Number.isFinite(maximumSlots) && maximumSlots > 0
      ? Math.max(1, Math.floor(maximumSlots))
      : 3;
  }

  get slotCount(): number {
    return this.slots.size;
  }

  get inFlightCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.inFlight) {
        count += 1;
      }
    }
    return count;
  }

  acquire(nodeCount: number): SnapshotTransferLease | undefined {
    const requiredNodeCount = validNodeCount(nodeCount) ? nodeCount : 0;
    let slot = [...this.slots.values()].find((candidate) => !candidate.inFlight);
    if (!slot) {
      if (this.slots.size >= this.maximumSlots) {
        return undefined;
      }
      slot = {
        poolId: this.nextPoolId++,
        buffers: allocateBuffers(requiredNodeCount),
        inFlight: false
      };
      this.slots.set(slot.poolId, slot);
    } else if (!matchesNodeCount(slot.buffers, requiredNodeCount)) {
      slot.buffers = allocateBuffers(requiredNodeCount);
    }
    slot.inFlight = true;
    return { poolId: slot.poolId, buffers: slot.buffers };
  }

  reclaim(lease: SnapshotTransferLease): boolean {
    const slot = this.slots.get(lease.poolId);
    if (!slot || !slot.inFlight || !hasValidBuffers(lease.buffers)) {
      return false;
    }
    slot.buffers = lease.buffers;
    slot.inFlight = false;
    return true;
  }

  clear(): void {
    this.slots.clear();
  }
}

function allocateBuffers(nodeCount: number): SnapshotTransferBuffers {
  return {
    nodeIndices: new Uint32Array(nodeCount),
    positions: new Float32Array(nodeCount * 3),
    velocities: new Float32Array(nodeCount * 3)
  };
}

function matchesNodeCount(buffers: SnapshotTransferBuffers, nodeCount: number): boolean {
  return buffers.nodeIndices.length === nodeCount
    && buffers.positions.length === nodeCount * 3
    && buffers.velocities.length === nodeCount * 3;
}

function hasValidBuffers(buffers: SnapshotTransferBuffers): boolean {
  return buffers.nodeIndices instanceof Uint32Array
    && buffers.positions instanceof Float32Array
    && buffers.velocities instanceof Float32Array
    && matchesNodeCount(buffers, buffers.nodeIndices.length);
}

function validNodeCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
