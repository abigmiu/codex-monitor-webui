import type { DictationEvent, DictationModelStatus } from "../types";

type DictationListener = (event: DictationEvent) => void;

type DictationState = "idle" | "listening" | "processing";

type RecognitionErrorEvent = {
  error?: string;
};

type RecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript?: string }>>;
};

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionCtor = new () => RecognitionLike;

type DictationController = {
  state: DictationState;
  recognition: RecognitionLike | null;
};

const listeners = new Set<DictationListener>();

const controller: DictationController = {
  state: "idle",
  recognition: null,
};

function emit(event: DictationEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[dictation] listener failed", error);
    }
  }
}

function getRecognitionConstructor(): RecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const source = window as Window & {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return source.SpeechRecognition || source.webkitSpeechRecognition || null;
}

function setState(state: DictationState) {
  controller.state = state;
  emit({ type: "state", state });
}

function createRecognition(preferredLanguage: string | null) {
  const RecognitionCtor = getRecognitionConstructor();
  if (!RecognitionCtor) {
    return null;
  }
  const recognition = new RecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  if (preferredLanguage && preferredLanguage.trim()) {
    recognition.lang = preferredLanguage.trim();
  }
  return recognition;
}

function stopRecognition() {
  if (!controller.recognition) {
    return;
  }
  const recognition = controller.recognition;
  controller.recognition = null;
  recognition.onstart = null;
  recognition.onend = null;
  recognition.onerror = null;
  recognition.onresult = null;
  recognition.stop();
}

export function requestDictationPermissionWeb() {
  return Promise.resolve(Boolean(getRecognitionConstructor()));
}

export function getDictationModelStatusWeb(modelId: string): DictationModelStatus {
  const supported = Boolean(getRecognitionConstructor());
  return {
    state: supported ? "ready" : "missing",
    modelId,
    progress: null,
    error: supported ? null : "SpeechRecognition is not supported in this browser.",
    path: null,
  };
}

export async function startDictationWeb(preferredLanguage: string | null) {
  const recognition = createRecognition(preferredLanguage);
  if (!recognition) {
    emit({
      type: "error",
      message: "Speech recognition is not supported in this browser.",
    });
    return "idle" as const;
  }

  stopRecognition();
  controller.recognition = recognition;

  recognition.onstart = () => {
    setState("listening");
  };

  recognition.onresult = (event: RecognitionResultEvent) => {
    let transcript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      transcript += event.results[index][0]?.transcript ?? "";
    }
    if (transcript.trim()) {
      emit({ type: "transcript", text: transcript.trim() });
    }
    emit({ type: "level", value: 1 });
  };

  recognition.onerror = (event: RecognitionErrorEvent) => {
    emit({ type: "error", message: event.error || "Dictation failed." });
    setState("idle");
  };

  recognition.onend = () => {
    if (controller.recognition === recognition) {
      controller.recognition = null;
    }
    setState("idle");
  };

  recognition.start();
  setState("listening");
  return "listening" as const;
}

export async function stopDictationWeb() {
  if (controller.recognition) {
    setState("processing");
    stopRecognition();
  }
  return "idle" as const;
}

export async function cancelDictationWeb() {
  if (controller.recognition) {
    stopRecognition();
  }
  emit({ type: "canceled", message: "Dictation canceled." });
  setState("idle");
  return "idle" as const;
}

export function subscribeDictationWeb(listener: DictationListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
