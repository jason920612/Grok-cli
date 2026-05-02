export type FileOverview = {
  lineCount: number;
  imports: Array<{ line: number; text: string }>;
  exports: Array<{ line: number; text: string }>;
  symbols: Array<{ name: string; kind: string; line: number }>;
};

export function getFileOverviewContent(content: string): FileOverview {
  const lines = content.split(/\r?\n/);
  const imports: FileOverview["imports"] = [];
  const exports: FileOverview["exports"] = [];
  const symbols: FileOverview["symbols"] = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (/^import\s/.test(trimmed)) imports.push({ line: lineNo, text: trimmed });
    if (/^export\s/.test(trimmed)) exports.push({ line: lineNo, text: trimmed });
    const match = trimmed.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/)
      ?? trimmed.match(/^(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/);
    if (match) symbols.push({ name: match[1] ?? "unknown", kind: inferKind(trimmed), line: lineNo });
  });
  return { lineCount: lines.length, imports, exports, symbols };
}

function inferKind(line: string): string {
  if (line.includes("class ")) return "class";
  if (line.includes("interface ")) return "interface";
  if (line.includes("type ")) return "type";
  if (line.includes("function ")) return "function";
  if (/=>/.test(line)) return "const";
  return "method";
}
