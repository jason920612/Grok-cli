export type SearchTreeResultKind =
  | "keyword"
  | "symbol"
  | "entrypoint"
  | "dependency"
  | "test"
  | "runtime_error"
  | "documentation";

export type SearchTreeResult = {
  path: string;
  startLine?: number;
  endLine?: number;
  kind: SearchTreeResultKind;
  score: number;
  reason: string;
};

export type RelatedFilesResult = {
  imports: string[];
  exports: string[];
  importedBy: string[];
  tests: string[];
  relatedSymbols: string[];
};

export interface SearchTreeToolDesign {
  search_code(query: string): Promise<SearchTreeResult[]>;
  find_symbol(name: string): Promise<SearchTreeResult[]>;
  expand_node(nodeIdOrPath: string): Promise<RelatedFilesResult>;
  get_related_files(path: string): Promise<RelatedFilesResult>;
}

// TODO: Wire these designs into local tools when the project adds a real
// symbol index, dependency graph, or semantic search backend. The current MVP
// intentionally relies on list_files, search_text, search_symbols,
// get_file_overview, and read_file_range.
