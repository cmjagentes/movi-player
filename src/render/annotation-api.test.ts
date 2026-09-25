import { describe, expect, test } from "vitest";
import {
  captureOwnedAnnotationFrame,
  CoalescedSeekQueue,
  executeSettledSeek,
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


function fakeSource(name: string): CanvasImageSource {
  return { name } as unknown as CanvasImageSource;
}

function fakeBitmap(width: number, height: number) {
  let closed = false;
  const image = {
    width,
    height,
    close() {
      closed = true;
    },
  } as unknown as ImageBitmap;
  return { image, closed: () => closed };
}

describe("annotation frame capture contract", () => {
  test("captures a software-decoded rendered canvas with dimensions and media time", async () => {
    const canvas = fakeSource("canvas");
    const bitmap = fakeBitmap(640, 360);
    const result = await captureOwnedAnnotationFrame({
      mediaTime: 1.25,
      preferredSource: null,
      renderedCanvas: canvas,
      createBitmap: async (source) => {
        expect(source).toBe(canvas);
        return bitmap.image;
      },
      isCanvasBitmapBlank: () => false,
    });

    expect(result).toEqual({
      image: bitmap.image,
      width: 640,
      height: 360,
      mediaTime: 1.25,
    });
    expect(bitmap.closed()).toBe(false);
  });

  test("prefers the current decoded frame and leaves its ImageBitmap caller-owned", async () => {
    const decoded = fakeSource("decoded-video-frame");
    const canvas = fakeSource("canvas");
    const bitmap = fakeBitmap(1920, 1080);
    const seen: CanvasImageSource[] = [];
    const result = await captureOwnedAnnotationFrame({
      mediaTime: 12.4,
      preferredSource: decoded,
      renderedCanvas: canvas,
      createBitmap: async (source) => {
        seen.push(source);
        return bitmap.image;
      },
      isCanvasBitmapBlank: () => {
        throw new Error("canvas sampling must not run for decoded frame capture");
      },
    });

    expect(seen).toEqual([decoded]);
    expect(result?.width).toBe(1920);
    expect(result?.height).toBe(1080);
    expect(result?.mediaTime).toBe(12.4);
    expect(bitmap.closed()).toBe(false);
    result?.image.close();
    expect(bitmap.closed()).toBe(true);
  });

  test("captures a native/MSE video source through the same preferred-source path", async () => {
    const nativeVideo = fakeSource("native-video");
    const bitmap = fakeBitmap(1280, 720);
    const result = await captureOwnedAnnotationFrame({
      mediaTime: 8,
      preferredSource: nativeVideo,
      renderedCanvas: null,
      createBitmap: async (source) => {
        expect(source).toBe(nativeVideo);
        return bitmap.image;
      },
      isCanvasBitmapBlank: () => false,
    });

    expect(result).toMatchObject({
      image: bitmap.image,
      width: 1280,
      height: 720,
      mediaTime: 8,
    });
  });

  test("falls back to a non-black rendered canvas when decoded-frame copying fails", async () => {
    const decoded = fakeSource("decoded-video-frame");
    const canvas = fakeSource("canvas");
    const bitmap = fakeBitmap(854, 480);
    const result = await captureOwnedAnnotationFrame({
      mediaTime: 3,
      preferredSource: decoded,
      renderedCanvas: canvas,
      createBitmap: async (source) => {
        if (source === decoded) throw new Error("decoded frame already closed");
        expect(source).toBe(canvas);
        return bitmap.image;
      },
      isCanvasBitmapBlank: (image) => {
        expect(image).toBe(bitmap.image);
        return false;
      },
    });

    expect(result?.image).toBe(bitmap.image);
    expect(bitmap.closed()).toBe(false);
  });

  test("rejects and closes an all-black rendered-canvas readback", async () => {
    const bitmap = fakeBitmap(640, 360);
    const result = await captureOwnedAnnotationFrame({
      mediaTime: 2,
      preferredSource: null,
      renderedCanvas: fakeSource("black-canvas"),
      createBitmap: async () => bitmap.image,
      isCanvasBitmapBlank: () => true,
    });

    expect(result).toBeNull();
    expect(bitmap.closed()).toBe(true);
  });
});

describe("settled annotation seek contract", () => {
  test("does not resolve at dispatch; waits for seeked and presented-frame settlement", async () => {
    const events = new EventTarget();
    const abort = new AbortController();
    let currentTime = 0;
    let dispatchedTarget: number | null = null;
    let settlePresented!: (time: number) => void;
    const presented = new Promise<number>((resolve) => {
      settlePresented = resolve;
    });
    let resolved = false;

    const promise = executeSettledSeek(
      4.25,
      abort.signal,
      {
        currentTime: () => currentTime,
        setCurrentTime: (target) => {
          dispatchedTarget = target;
          currentTime = target;
        },
        addEventListener: (type, listener) =>
          events.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
          events.removeEventListener(type, listener),
        waitForPresentedFrame: async (target) => {
          expect(target).toBe(4.25);
          return presented;
        },
      },
      1_000,
    ).then((value) => {
      resolved = true;
      return value;
    });

    expect(dispatchedTarget).toBe(4.25);
    await Promise.resolve();
    expect(resolved).toBe(false);

    events.dispatchEvent(new Event("seeked"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    settlePresented(4.26);
    await expect(promise).resolves.toBe(4.26);
    expect(resolved).toBe(true);
  });

  test("rejects an outstanding seek when the source/element is destroyed", async () => {
    const events = new EventTarget();
    const abort = new AbortController();
    let currentTime = 0;
    const promise = executeSettledSeek(
      7,
      abort.signal,
      {
        currentTime: () => currentTime,
        setCurrentTime: (target) => {
          currentTime = target;
        },
        addEventListener: (type, listener) =>
          events.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
          events.removeEventListener(type, listener),
        waitForPresentedFrame: () => new Promise<number>(() => {}),
      },
      1_000,
    );

    abort.abort(new Error("player destroyed"));
    await expect(promise).rejects.toThrow("player destroyed");
  });
});
