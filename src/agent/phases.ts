import type { Call } from "./types.ts";

const PHASE_ONE_CATEGORIES = new Set(["sanctions", "labels"]);

export function phaseGroups(calls: Call[]): Call[][] {
  const phase1: Call[] = [];
  const phase2: Call[] = [];

  for (const call of calls) {
    if (PHASE_ONE_CATEGORIES.has(call.category)) {
      call.phase = 1;
      phase1.push(call);
    } else {
      call.phase = 2;
      phase2.push(call);
    }
  }

  const result: Call[][] = [];
  if (phase1.length > 0) result.push(phase1);
  if (phase2.length > 0) result.push(phase2);
  return result;
}
