# Code Navigation Skill

Use precise code navigation.

Preferred workflow:
1. Find candidate files with list_files, search_text, search_symbols.
2. Inspect structure with get_file_overview.
3. Read only relevant ranges with read_file_range.
4. Expand gradually.
5. When editing, read exact region, nearby imports, related tests, and call sites.

Bad:
- Reading a 900-line file from top to bottom.

Good:
- search_symbols("createServer")
- get_file_overview("src/server.ts")
- read_file_range("src/server.ts", 40, 120)
