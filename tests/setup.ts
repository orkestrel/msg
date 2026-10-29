// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window`: this package is core-only.
//
// The fleet-wide helpers live in `@orkestrel/test`. What remains here is what
// is specific to this package: the byte and eml fixture builders, extracted the
// moment they could serve another test, per `.claude/rules/tests.md`
// § Shared test infrastructure.

// ── Byte fixture builders (generic, environment-agnostic) ──────────────────

/**
 * Encodes each character of a string to one byte (`charCodeAt`), for
 * building ASCII/latin1 wire-format fixtures without `node:buffer`.
 */
export function asciiBytes(text: string): Uint8Array {
	return Uint8Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))
}

/**
 * Returns a copy of `source` with each `[offset, value]` edit applied —
 * `source` itself is never mutated.
 */
export function patchBytes(
	source: Uint8Array,
	edits: ReadonlyArray<readonly [number, number]>,
): Uint8Array {
	// A Buffer's own slice shares memory, so the copy is constructed rather than sliced.
	const copy = new Uint8Array(source)
	for (const [offset, value] of edits) copy[offset] = value
	return copy
}

/**
 * Builds a minimal RFC 2822 message from `headers` and `body` — each
 * `"Name: value"` line, a blank line, then the body, all CRLF-terminated —
 * returned as bytes through {@link asciiBytes}.
 */
export function buildEml(
	headers: ReadonlyArray<readonly [string, string]>,
	body: string,
): Uint8Array {
	const headerLines = headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')
	const message = `${headerLines}\r\n\r\n${body}`
	return asciiBytes(message)
}

/**
 * Builds an eml whose body nests `multipart/mixed` parts `depth` levels
 * deep — a unique boundary per level (derived deterministically from the
 * level index, no randomness), CRLF line endings, innermost part is
 * `text/plain`. `depth` of `0` yields a plain (non-multipart) message.
 */
export function buildNestedMultipart(depth: number): Uint8Array {
	const levels = Array.from(
		{ length: Math.max(0, Math.floor(depth)) },
		(_, index) => depth - 1 - index,
	).reverse()
	const contentType =
		levels.length === 0 ? 'text/plain' : `multipart/mixed; boundary="level${levels[0]}"`
	const prefixes = levels.map((level, index) => {
		const next = levels[index + 1]
		const content = next === undefined ? 'text/plain' : `multipart/mixed; boundary="level${next}"`
		return `--level${level}\r\nContent-Type: ${content}\r\n\r\n`
	})
	const suffixes = levels.toReversed().map((level) => `\r\n--level${level}--`)
	return buildEml([['Content-Type', contentType]], [...prefixes, 'leaf', ...suffixes].join(''))
}
