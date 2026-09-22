export function ratioToPercent(ratio: number): number {
  return Number((ratio * 100).toFixed(10));
}

export function percentToRatio(percent: string | number): number {
  const value = Number(percent);
  return (Number.isFinite(value) ? value : 0) / 100;
}
