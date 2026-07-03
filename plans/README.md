# Plans

Specs (`specs/`) describe **state** — what should be true. Plans describe **motion** — how we're getting there next. Every chunk of work lands as a plan file here; once merged, it freezes as the historical record of what got built.

The full protocol (frontmatter schema, body template, status lifecycle, closeout ritual) lives in the specops skill: `.claude/skills/specops/references/plans-protocol.md`.

Query the DAG (no hand-maintained status tables here — they rot):

```sh
.claude/skills/specops/scripts/specops           # dashboard
.claude/skills/specops/scripts/specops next      # what to work on next
.claude/skills/specops/scripts/specops dag       # mermaid graph
```

The initial DAG was seeded from the Rust-migration GitHub issues (#434–#438) plus the FFI-robustness findings from gitsheets' holo-tree spike; each plan's `issues:` frontmatter links back.
