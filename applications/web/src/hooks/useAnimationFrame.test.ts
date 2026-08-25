// Tests for src/hooks/useAnimationFrame.ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAnimationFrame } from '~/hooks/useAnimationFrame.js';

describe('useAnimationFrame', () => {
  it('does not start a loop when disabled', () => {
    const callback = vi.fn();
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    renderHook(() => useAnimationFrame(callback, false));
    expect(rafSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it('reports dt = 0 on the first frame, then real elapsed time on the next', () => {
    const callback = vi.fn();
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0);

    renderHook(() => useAnimationFrame(callback, true));

    const tick = rafSpy.mock.calls[0]?.[0] as ((ts: number) => void) | undefined;
    expect(tick).toBeDefined();

    tick?.(1000);
    expect(callback).toHaveBeenNthCalledWith(1, 0);

    tick?.(1016);
    expect(callback).toHaveBeenNthCalledWith(2, 0.016);

    rafSpy.mockRestore();
  });

  it('clamps dt to 0.05s even after a long gap between frames', () => {
    const callback = vi.fn();
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 0);

    renderHook(() => useAnimationFrame(callback, true));

    const tick = rafSpy.mock.calls[0]?.[0] as ((ts: number) => void) | undefined;
    expect(tick).toBeDefined();

    tick?.(1000);
    tick?.(6000); // a 5s gap — simulates a dropped/backgrounded frame

    expect(callback).toHaveBeenNthCalledWith(2, 0.05);

    rafSpy.mockRestore();
  });

  it('cancels the loop on unmount', () => {
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { unmount } = renderHook(() => useAnimationFrame(vi.fn(), true));
    unmount();
    expect(cafSpy).toHaveBeenCalled();
    cafSpy.mockRestore();
  });

  it('cancels the loop when `enabled` flips to false', () => {
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { rerender } = renderHook(({ enabled }) => useAnimationFrame(vi.fn(), enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    expect(cafSpy).toHaveBeenCalled();
    cafSpy.mockRestore();
  });
});
