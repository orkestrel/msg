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
 * Encode an ASCII/latin1 string to bytes, one byte per character
 * (`charCodeAt`) — used to build wire-format fixtures without `node:buffer`.
 */
export function asciiBytes(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length)
	for (let index = 0; index < text.length; index += 1) {
		bytes[index] = text.charCodeAt(index)
	}
	return bytes
}

/**
 * Return a COPY of `source` with each `[offset, value]` edit applied —
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
 * Build a minimal RFC 2822 message from `headers` and `body` — each
 * `"Name: value"` line, a blank line, then the body, all CRLF-terminated —
 * returned as bytes via {@link asciiBytes}.
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
 * Build an eml whose body nests `multipart/mixed` parts `depth` levels
 * deep — a unique boundary per level (derived deterministically from the
 * level index, no randomness), CRLF line endings, innermost part is
 * `text/plain`. `depth` of `0` yields a plain (non-multipart) message.
 */
export function buildNestedMultipart(depth: number): Uint8Array {
	let body = 'leaf'
	let contentType = 'text/plain'
	for (let level = depth - 1; level >= 0; level -= 1) {
		const boundary = `level${level}`
		body = `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n--${boundary}--`
		contentType = `multipart/mixed; boundary="${boundary}"`
	}
	return buildEml([['Content-Type', contentType]], body)
}
