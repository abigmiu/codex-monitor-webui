// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../../../platform/opener";
import type { DebugEntry } from "../../../types";
import { useUpdater } from "./useUpdater";

vi.mock("../../../platform/opener", () => ({
  openExternalUrl: vi.fn(),
}));

describe("useUpdater (web)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    (globalThis as any).__APP_VERSION__ = "0.0.1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sets error state when release check fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const onDebug = vi.fn();

    const { result } = renderHook(() => useUpdater({ onDebug }));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("error");
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "updater/error",
        source: "error",
      } satisfies Partial<DebugEntry>),
    );
  });

  it("marks update available and opens the download page", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: "9.9.9", html_url: "https://example.com/release" }),
    });

    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("available");
    expect(result.current.state.version).toBe("9.9.9");

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(vi.mocked(openExternalUrl)).toHaveBeenCalledWith("https://example.com/release");
    expect(result.current.state.stage).toBe("restarting");
  });
});

