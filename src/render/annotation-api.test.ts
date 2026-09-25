import { describe, expect, test } from "vitest";
import {
  CoalescedSeekQueue,
  isNearBlackRgba,
  normalizeSeekSeconds,
} from "./annotation-api";

describe("annotation seek contract", () => {
  test("rejects non-finite targets and clamps finite targets to media bounds", () => {
    expect(() => normalizeSeekSeconds(Number.NaN, 10)).toThrow();
    expect(() => normalizeSeekSeconds(Number.POSITIVE_INFINITY, 10)).toThrow();
    expect(normalizeSeekSeconds(-1, 10)).toBe(0);
    expect(normalizeSeekSeconds(4.25, 10)).toBe(4.25);
    expect(normalizeSeekSeconds(12, 10)).toBe(10);
    expect(normalizeSeekSeconds(12, 0)).toBe(12);
  });

  test("keeps only the latest queued seek while one seek is active", async () => {
    const queue = new CoalescedSeekQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executed: number[] = [];
    const execute = async (target: number) => {
      executed.push(target);
      if (target === 1) await firstGate;
      return target;
    };

    const first = queue.enqueue(1, execute);
    await Promise.resolve();
    const second = queue.enqueue(2, execute);
    const third = queue.enqueue(3, execute);

    await expect(second).rejects.toThrow("superseded");
    releaseFirst();

    await expect(first).resolves.toBe(1);
    await expect(third).resolves.toBe(3);
    expect(executed).toEqual([1, 3]);
  });

  test("cancels a queued seek without corrupting the active request", async () => {
    const queue = new CoalescedSeekQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = async (target: number) => {
      if (target === 1) await firstGate;
      return target;
    };

    const first = queue.enqueue(1, execute);
    await Promise.resolve();
    const queued = queue.enqueue(2, execute);
    queue.cancelPending(new Error("player destroyed"));

    await expect(queued).rejects.toThrow("player destroyed");
    releaseFirst();
    await expect(first).resolves.toBe(1);
  });
});

describe("annotation capture sampling", () => {
  test("detects near-black RGBA samples using the snapshot threshold", () => {
    expect(isNearBlackRgba(new Uint8ClampedArray([0, 0, 0, 255, 8, 8, 8, 255]))).toBe(true);
    expect(isNearBlackRgba(new Uint8ClampedArray([0, 0, 0, 255, 9, 0, 0, 255]))).toBe(false);
  });
});
