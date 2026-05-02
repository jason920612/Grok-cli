# find_symbol

Find scored symbol definition candidates.

- Use for functions, classes, types, interfaces, commands, tool names, and exported API names.
- Prefer this over broad text search when the task names a code symbol.
- Follow definition candidates with read_file_range around the symbol.
- If no symbol is found, fall back to search_code or search_text.
