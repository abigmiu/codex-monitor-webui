import { useEffect, useState } from "react";

export function useWindowFocusState() {
  const [isFocused, setIsFocused] = useState(() => {
    if (typeof document === "undefined") {
      return true;
    }
    return document.hasFocus();
  });

  useEffect(() => {
    const handleFocus = () => setIsFocused(true);
    const handleBlur = () => setIsFocused(false);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        handleFocus();
      } else {
        handleBlur();
      }
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return isFocused;
}
