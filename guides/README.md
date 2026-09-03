# Guides

A dual-axis index into this repository's guides — by concept, and by directory, as `.claude/rules/documentation.md` § Authority and workflow requires.

## By concept

| Concept | Spec               | Source                    | Tests                                 |
| ------- | ------------------ | ------------------------- | ------------------------------------- |
| MSG     | [`msg.md`](msg.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide              |
| ---------- | ------------------ |
| `src/core` | [`msg.md`](msg.md) |

## Dependency reference

`@orkestrel/msg` is a **core-only** package and declares no `@orkestrel/*`
runtime dependency, so nothing a consumer installs is mirrored here. What this
directory does hold is one byte-identical mirror per declared `@orkestrel/*`
development dependency:

- [`guide.md`](guide.md) mirrors the guide for `@orkestrel/guide`, which powers
  the guides-parity suite (`tests/guides.test.ts`).
- [`test.md`](test.md) mirrors the guide for `@orkestrel/test`, which supplies
  the shared test helpers every suite here imports.
- [`scaffold.md`](scaffold.md) mirrors the guide for `@orkestrel/scaffold`,
  which owns this workspace's structure and its vendored files.
- [`probe.md`](probe.md) mirrors the guide for `@orkestrel/probe`, which runs a
  claim's case and its negative control against this workspace.

Each documents **that package's** surface, not anything sourced in this
repository. Each is kept here so a reader can see the primitives this
repository's suites and tooling are built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding contract, whose rule map names `.claude/rules/documentation.md` § Parity for documentation-as-contracts.
