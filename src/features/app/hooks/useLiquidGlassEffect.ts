import { useEffect } from "react";
import type { DebugEntry } from "../../../types";

type Params = {
  reduceTransparency: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

export function useLiquidGlassEffect({ reduceTransparency, onDebug }: Params) {
  useEffect(() => {
    if (!reduceTransparency) {
      onDebug?.({
        id: `${Date.now()}-client-liquid-glass-noop`,
        timestamp: Date.now(),
        source: "event",
        label: "liquid-glass/noop",
        payload: "Web build does not support native liquid glass effects.",
      });
    }
  }, [onDebug, reduceTransparency]);
}
