# search_code

Search the codebase with tree-navigation scoring across paths, exact text, and symbol definitions.

- Use early in tree-based code navigation when a branch has a concrete query.
- Prefer exact task terms, implementation terms, command names, error text, and likely filenames.
- Treat scores and reasons as candidate ranking, not proof.
- Follow high-scoring results with get_file_overview or read_file_range.
- Avoid broad vague queries that return many weak matches.
