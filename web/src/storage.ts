import type { SavedPlan } from "./types";

const KEY = "wardo.lastPlan";

export function saveLastPlan(p: SavedPlan): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage may be unavailable (private mode, quota) — degrade silently
  }
}

export function loadLastPlan(): SavedPlan | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedPlan;
  } catch {
    return null;
  }
}

export function clearLastPlan(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
