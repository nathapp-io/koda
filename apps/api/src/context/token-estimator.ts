export function estimateTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}
