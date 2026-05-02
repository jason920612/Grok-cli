export function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}
