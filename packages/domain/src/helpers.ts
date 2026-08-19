export function requiredCapacity(session: {participantCount: number; minCapacity?: number}): number {
  return Math.max(session.participantCount, session.minCapacity ?? 0);
}

export function lowerSet(values: string[]): Set<string> {
  return new Set(values.map(value => value.toLocaleLowerCase()));
}

export function contiguousBlocks<T extends {dayId: string; index: number; isBreak?: boolean}>(slots: T[], duration: number): T[][] {
  const result: T[][] = [];
  const days = new Map<string, T[]>();
  for (const slot of slots.filter(item => !item.isBreak)) {
    days.set(slot.dayId, [...(days.get(slot.dayId) ?? []), slot]);
  }
  for (const daySlots of days.values()) {
    const ordered = [...daySlots].sort((a, b) => a.index - b.index);
    for (let i = 0; i <= ordered.length - duration; i++) {
      const block = ordered.slice(i, i + duration);
      if (block.every((slot, index) => index === 0 || slot.index === block[index - 1].index + 1)) result.push(block);
    }
  }
  return result;
}
