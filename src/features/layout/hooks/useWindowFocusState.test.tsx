/* @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWindowFocusState } from "./useWindowFocusState";

describe("useWindowFocusState", () => {
	it("falls back to DOM focus state when Tauri window is unavailable", () => {
		const { result, unmount } = renderHook(() => useWindowFocusState());
		expect(typeof result.current).toBe("boolean");
		unmount();
	});
});
