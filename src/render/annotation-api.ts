export type SeekExecutor = (targetSeconds: number) => Promise<number>;

type SeekRequest = {
  targetSeconds: number;
  execute: SeekExecutor;
  resolve: (settledSeconds: number) => void;
  reject: (error: unknown) => void;
};

export function normalizeSeekSeconds(
  value: number,
  durationSeconds: number,
): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Seek target must be a finite number.");
  }
  const lowerBounded = Math.max(0, value);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return Math.min(lowerBounded, durationSeconds);
  }
  return lowerBounded;
}

export function isNearBlackRgba(
  data: ArrayLike<number>,
  threshold = 8,
): boolean {
  for (let index = 0; index + 2 < data.length; index += 4) {
    if (
      data[index] > threshold ||
      data[index + 1] > threshold ||
      data[index + 2] > threshold
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Serializes precise annotation seeks while keeping at most one queued target.
 * The active seek is allowed to settle; if more requests arrive meanwhile, only
 * the newest queued target runs next.
 */
export class CoalescedSeekQueue {
  private active = false;
  private queued: SeekRequest | null = null;

  enqueue(targetSeconds: number, execute: SeekExecutor): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const request: SeekRequest = {
        targetSeconds,
        execute,
        resolve,
        reject,
      };
      if (!this.active) {
        void this.run(request);
        return;
      }
      if (this.queued) {
        this.queued.reject(
          new Error("Seek request superseded by a newer target."),
        );
      }
      this.queued = request;
    });
  }

  cancelPending(error: Error): void {
    if (!this.queued) return;
    const queued = this.queued;
    this.queued = null;
    queued.reject(error);
  }

  private async run(request: SeekRequest): Promise<void> {
    this.active = true;
    try {
      request.resolve(await request.execute(request.targetSeconds));
    } catch (error) {
      request.reject(error);
    } finally {
      this.active = false;
      const next = this.queued;
      this.queued = null;
      if (next) void this.run(next);
    }
  }
}
