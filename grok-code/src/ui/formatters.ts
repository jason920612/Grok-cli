export function formatContext(items: Array<{ id: string; type: string; tokensEstimate: number; content: string }>): string {
  return items.map((item) => `${item.id} [${item.type}] ${item.tokensEstimate} tokens\n${item.content.slice(0, 240)}`).join("\n\n");
}
