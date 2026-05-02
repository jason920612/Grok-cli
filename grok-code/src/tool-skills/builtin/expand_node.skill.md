# expand_node

Expand one search-tree file node.

- Use only on high-confidence nodes.
- Returns direct imports, imported-by candidates, tests, exports, and related symbols.
- Expand at most top 3 nodes per search-tree layer.
- Stop expanding when the owner file, call path, and test/verification route are clear.
