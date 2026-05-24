import { useEffect, useState } from "react";

export function useLocation(): string {
  const [path, setPath] = useState<string>(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    window.addEventListener("ward-o-navigate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("ward-o-navigate", onPop);
    };
  }, []);
  return path;
}

export function navigate(to: string) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === to) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new Event("ward-o-navigate"));
}
