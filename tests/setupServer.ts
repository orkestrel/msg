// Node-only test setup — the `node:fs` fixture loader the core suites read their
// binary email fixtures through. `node:fs` and `node:path` imports belong here,
// never in `setup.ts`, which stays host-independent. Every path anchors to
// `WORKSPACE_ROOT` so the runner's working directory never decides what a fixture
// resolves to, per `.claude/rules/tests.md` § Shared test infrastructure.
//
// No project loads this file through `setupFiles`: `workspace.md`'s project matrix
// lists it as the setup for `src:server`, `src:bin`, and `app:server`, and this
// package declares none of them. The `src:core` suites import it directly instead.
// That is sound because the project already runs in a Node environment, and it
// leaves `src/core` itself host-independent — nothing here is reachable from the
// published graph.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRoot } from '@orkestrel/test'

/**
 * Holds the absolute workspace root every path in this module resolves against.
 *
 * @remarks
 * `resolveRoot` resolves this file's own URL to the directory one above `tests/`.
 * The readers take a path string, so the URL is converted once here.
 */
export const WORKSPACE_ROOT = fileURLToPath(resolveRoot(import.meta))

/** Holds the directory carrying the binary `.msg` fixtures the core suites read. */
export const FIXTURES_ROOT = join(WORKSPACE_ROOT, 'tests', 'src', 'core', 'fixtures')

/**
 * Reads one binary fixture from {@link FIXTURES_ROOT} into bytes it owns.
 *
 * @param name - File name of the fixture, without any directory part.
 * @returns The fixture's bytes, copied out of the `node:fs` read so the caller
 * holds a plain `Uint8Array` whose `slice` copies rather than aliasing.
 * @throws The `node:fs` error when the directory holds no fixture of that name.
 * @remarks `readFileSync` returns a Node `Buffer`, whose overridden `slice` shares
 * memory with the read. Copying here is what keeps one caller's edit off another's
 * bytes, and it is why every suite reads through this one loader.
 *
 * @example
 * ```ts
 * const bytes = readFixture('test.msg')
 * bytes.slice(0, 8) // a copy — editing it leaves the fixture's own bytes alone
 * ```
 */
export function readFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES_ROOT, name)))
}
