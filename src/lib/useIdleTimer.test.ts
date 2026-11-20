import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIdleTimer } from "./useIdleTimer";

// #646: exercise the real hook (via renderHook) instead of re-implementing its timers.

const TIMEOUT = 5000;
const WARN_BEFORE = 1000;

function setup() {
  const onWarn = vi.fn();
  const onIdle = vi.fn();
  const hook = renderHook(() =>
    useIdleTimer({ timeoutMs: TIMEOUT, warnBeforeMs: WARN_BEFORE, onWarn, onIdle }),
  );
  return { onWarn, onIdle, hook };
}

describe("#287/#646 useIdleTimer — timer logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onWarn after (timeout - warnBefore) ms and onIdle at timeout", () => {
    const { onWarn, onIdle } = setup();

    act(() => {
      vi.advanceTimersByTime(TIMEOUT - WARN_BEFORE);
    });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onIdle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(WARN_BEFORE);
    });
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("reset() before the warn threshold delays both callbacks", () => {
    const { onWarn, onIdle, hook } = setup();

    // Activity at 3000 ms resets the timers.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      hook.result.current.reset();
    });

    // 3000 + (TIMEOUT - WARN_BEFORE) = 7000 ms: warn fires, idle has not.
    act(() => {
      vi.advanceTimersByTime(TIMEOUT - WARN_BEFORE);
    });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onIdle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(WARN_BEFORE);
    });
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("exposes a remaining-seconds value that decreases while warning", () => {
    const { hook } = setup();

    act(() => {
      vi.advanceTimersByTime(TIMEOUT - WARN_BEFORE);
    });
    const first = hook.result.current.remainingSeconds;
    expect(first).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(hook.result.current.remainingSeconds).toBeLessThan(first);
  });
});
