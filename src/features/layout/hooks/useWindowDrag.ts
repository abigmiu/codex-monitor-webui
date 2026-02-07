import { useEffect } from "react";

export function useWindowDrag(_targetId: string) {
  useEffect(() => {
    // Web build: no native draggable window region.
  }, []);
}
