import type { SortingState } from "@tanstack/react-table";

export function nextSorting(current: SortingState, columnId: string): SortingState {
  const sorted = current[0];
  return [{ id: columnId, desc: sorted?.id === columnId ? !sorted.desc : false }];
}
