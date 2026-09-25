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

export type AnnotationCapturedFrame = {
  image: ImageBitmap;
  width: number;
  height: number;
  mediaTime: number;
};

export type AnnotationFrameCaptureInput = {
  mediaTime: number;
  preferredSource: CanvasImageSource | null;
  renderedCanvas: CanvasImageSource | null;
  createBitmap: (source: CanvasImageSource) => Promise<ImageBitmap>;
  isCanvasBitmapBlank: (image: ImageBitmap) => boolean;
};

/**
 * Copy the best currently-decoded frame into caller-owned ImageBitmap storage.
 * Raw decoded/native sources win; canvas readback is the fallback and is
 * rejected when it reproduces the known all-black hardware readback failure.
 */
export async function captureOwnedAnnotationFrame(
  input: AnnotationFrameCaptureInput,
): Promise<AnnotationCapturedFrame | null> {
  if (input.preferredSource) {
    try {
      const image = await input.createBitmap(input.preferredSource);
      return {
        image,
        width: image.width,
        height: image.height,
        mediaTime: input.mediaTime,
      };
    } catch {
      // Fall through to the rendered canvas. A decoded VideoFrame can become
      // invalid between presentation and the async copy.
    }
  }

  if (!input.renderedCanvas) return null;
  let image: ImageBitmap;
  try {
    image = await input.createBitmap(input.renderedCanvas);
  } catch {
    return null;
  }
  if (input.isCanvasBitmapBlank(image)) {
    image.close();
    return null;
  }
  return {
    image,
    width: image.width,
    height: image.height,
    mediaTime: input.mediaTime,
  };
}

export type SettledSeekDriver = {
  currentTime: () => number;
  setCurrentTime: (targetSeconds: number) => void;
  addEventListener: (
    type: "seeked" | "error",
    listener: (event: Event) => void,
  ) => void;
  removeEventListener: (
    type: "seeked" | "error",
    listener: (event: Event) => void,
  ) => void;
  waitForPresentedFrame: (
    targetSeconds: number,
    signal: AbortSignal,
  ) => Promise<number>;
};

/**
 * Start a media-element-style seek but resolve only after its seeked event and
 * the requested frame has been presented. This is the awaitable boundary used
 * by MoviElement.seekTo().
 */
export function executeSettledSeek(
  targetSeconds: number,
  signal: AbortSignal,
  driver: SettledSeekDriver,
  timeoutMs = 30_000,
): Promise<number> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Annotation seek was aborted."),
    );
  }

  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out seeking to ${targetSeconds.toFixed(3)}s.`,
        ),
      );
    }, timeoutMs);
    let presentationCheckInFlight = false;

    const cleanup = () => {
      clearTimeout(timeout);
      driver.removeEventListener("seeked", onSeeked);
      driver.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (event: Event) => {
      cleanup();
      const detail = (event as CustomEvent<unknown>).detail;
      reject(
        detail instanceof Error
          ? detail
          : new Error("Movi failed while seeking for annotation."),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Annotation seek was aborted."),
      );
    };
    const onSeeked = () => {
      if (
        Math.abs(driver.currentTime() - targetSeconds) > 0.25 ||
        presentationCheckInFlight
      ) {
        return;
      }
      presentationCheckInFlight = true;
      void driver
        .waitForPresentedFrame(targetSeconds, signal)
        .then((settled) => {
          cleanup();
          resolve(settled);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    };

    driver.addEventListener("seeked", onSeeked);
    driver.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    driver.setCurrentTime(targetSeconds);
  });
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
