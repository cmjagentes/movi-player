import { describe, expect, test, vi } from "vitest";

vi.mock("../wasm/FFmpegLoader", () => ({
  loadWasmModuleNew: vi.fn(),
  resetWasmModule: vi.fn(),
}));

import { MoviPlayer } from "./MoviPlayer";

describe("MoviPlayer pause intent", () => {
  test("clears stale seek and rebuffer resume intent on a normal user pause", () => {
    const player = Object.create(MoviPlayer.prototype) as MoviPlayer & Record<string, unknown>;
    const stateManager = {
      canPause: () => true,
      getState: () => "playing",
      setState: vi.fn(),
    };

    Object.assign(player, {
      streamWrapper: null,
      stateManager,
      wasPlayingBeforeSeek: true,
      wasPlayingBeforeRebuffer: true,
      releaseWakeLock: vi.fn(),
      clock: { pause: vi.fn() },
      disableAudio: true,
      videoRenderer: null,
      animationFrameId: null,
      stopBackgroundTimer: vi.fn(),
      startPauseBuffering: vi.fn(),
    });

    player.pause();

    expect((player as unknown as { wasPlayingBeforeSeek: boolean }).wasPlayingBeforeSeek).toBe(false);
    expect((player as unknown as { wasPlayingBeforeRebuffer: boolean }).wasPlayingBeforeRebuffer).toBe(false);
    expect(stateManager.setState).toHaveBeenCalledWith("paused");
  });
});
