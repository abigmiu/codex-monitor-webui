/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerImageDrop } from "./useComposerImageDrop";

let mockOnDragDropEvent:
  | ((event: {
      payload: {
        type: "enter" | "over" | "leave" | "drop";
        position: { x: number; y: number };
        files?: File[];
      };
    }) => void)
  | null = null;

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: (handler: typeof mockOnDragDropEvent) => {
    mockOnDragDropEvent = handler;
    return () => {};
  },
}));

type HookResult = ReturnType<typeof useComposerImageDrop>;

type RenderedHook = {
  result: HookResult;
  unmount: () => void;
};

function renderImageDropHook(options: { disabled: boolean; onAttachImages?: (paths: string[]) => void }): RenderedHook {
  let result: HookResult | undefined;

  function Test() {
    result = useComposerImageDrop(options);
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(React.createElement(Test));
  });

  return {
    get result() {
      if (!result) {
        throw new Error("Hook not rendered");
      }
      return result;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setMockFileReader() {
  const OriginalFileReader = window.FileReader;
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(file: File) {
      const name = encodeURIComponent(file.name || "file");
      this.result = `data:${file.type};name=${name};base64,MOCK`;
      this.onload?.({} as ProgressEvent<FileReader>);
    }
  }
  window.FileReader = MockFileReader as typeof FileReader;
  return () => {
    window.FileReader = OriginalFileReader;
  };
}

describe("useComposerImageDrop", () => {
  beforeEach(() => {
    mockOnDragDropEvent = null;
  });

  it("tracks drag over state for file transfers", () => {
    const hook = renderImageDropHook({ disabled: false });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      hook.result.handleDragLeave();
    });

    expect(hook.result.isDragOver).toBe(false);

    hook.unmount();
  });

  it("reads image data URLs on drop", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "photo.png", { type: "image/png" });

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/png;name=photo.png;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("reads image data URLs when paths are missing", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "photo.jpg", { type: "image/jpeg" });

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/jpeg;name=photo.jpg;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("handles pasted image items", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();

    const file = new File(["data"], "paste.png", { type: "image/png" });
    const item = {
      type: "image/png",
      getAsFile: () => file,
    };

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [item] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/png;name=paste.png;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("respects the drop target for global window drops", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const target = document.createElement("div");
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    hook.result.dropTargetRef.current = target;

    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });

    await act(async () => {
      await Promise.resolve();
    });

    if (!mockOnDragDropEvent) {
      throw new Error("Drag drop handler not registered");
    }

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "over",
          position: { x: 40, y: 40 },
          files: [],
        },
      });
    });

    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "drop",
          position: { x: 40, y: 40 },
          files: [
            new File(["data"], "photo.png", { type: "image/png" }),
            new File(["data"], "note.txt", { type: "text/plain" }),
          ],
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/png;name=photo.png;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("ignores drag/drop and paste when disabled", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: true, onAttachImages });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(false);

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    hook.unmount();
  });
});
