// The heap limit of a worker thread that reads or chunks one file (the Office reader, the structure
// chunker): a fifth of the memory the process may use (process.constrainedMemory(): the container's
// limit), between 256 and 384 MB; 384 when no limit is known. Each thread's own comment records how
// that range was measured for it. No imports: both thread modules load it.

const MiB = 1024 * 1024;
export const WORKER_HEAP_FLOOR_MB = 256;
export const WORKER_HEAP_CEILING_MB = 384;

export function workerHeapLimitMb(constrained: number | undefined = process.constrainedMemory?.()): number {
  // 0/undefined: no limit known; some Node versions report an unconstrained process as ~2^64.
  if (!constrained || !Number.isFinite(constrained) || constrained > 2 ** 40) return WORKER_HEAP_CEILING_MB;
  return Math.min(WORKER_HEAP_CEILING_MB, Math.max(WORKER_HEAP_FLOOR_MB, Math.floor(constrained / MiB / 5)));
}
