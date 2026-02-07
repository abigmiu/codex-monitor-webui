export type DragDropPayload = {
  type: "enter" | "over" | "leave" | "drop";
  position: { x: number; y: number };
  files?: File[];
};

export type DragDropEvent = {
  payload: DragDropPayload;
};

type Listener = (event: DragDropEvent) => void;

type SubscriptionOptions = {
  onError?: (error: unknown) => void;
};

const listeners = new Set<Listener>();
let initialized = false;

function emit(payload: DragDropPayload) {
  for (const listener of listeners) {
    try {
      listener({ payload });
    } catch (error) {
      console.error("[drag-drop] listener failed", error);
    }
  }
}

function toPayloadType(type: string): DragDropPayload["type"] | null {
  if (type === "dragenter") {
    return "enter";
  }
  if (type === "dragover") {
    return "over";
  }
  if (type === "dragleave") {
    return "leave";
  }
  if (type === "drop") {
    return "drop";
  }
  return null;
}

function ensureListeners(options?: SubscriptionOptions) {
  if (initialized || typeof window === "undefined") {
    return;
  }
  initialized = true;

  const handler = (event: DragEvent) => {
    const payloadType = toPayloadType(event.type);
    if (!payloadType) {
      return;
    }

    try {
      const files = Array.from(event.dataTransfer?.files ?? []);
      emit({
        type: payloadType,
        position: { x: event.clientX, y: event.clientY },
        files,
      });
    } catch (error) {
      options?.onError?.(error);
    }
  };

  window.addEventListener("dragenter", handler);
  window.addEventListener("dragover", handler);
  window.addEventListener("dragleave", handler);
  window.addEventListener("drop", handler);
}

export function subscribeWindowDragDrop(
  onEvent: Listener,
  options?: SubscriptionOptions,
) {
  listeners.add(onEvent);
  ensureListeners(options);
  return () => {
    listeners.delete(onEvent);
  };
}
