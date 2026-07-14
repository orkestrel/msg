// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window`: this package is core-only.
//
// Generic recorder infrastructure plus byte/eml fixture builders, extracted
// the moment they could serve another test (AGENTS §16.1).

// ── Recorders (generic, environment-agnostic) ──────────────────────────────

/**
 * A real callback that records its calls — use instead of a mock when a test
 * only needs to count invocations or inspect arguments.
 */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that pushes its
 * arguments onto a `calls` list instead of performing any real behavior.
 */
export function createRecorder<
	TArgs extends readonly unknown[] = readonly unknown[],
>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler: (...args: TArgs) => {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

/**
 * Narrow a possibly-`undefined` value to `T`, throwing (not `expect`ing) when
 * it is `undefined` — lets a caller assert on the value unconditionally
 * afterward instead of nesting `expect` inside an `if` (vitest/no-conditional-expect).
 */
export function expectDefined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('expected value to be defined')
	return value
}

/**
 * Invoke `fn` and return whatever it throws, or `undefined` if it completes
 * without throwing — lets a caller assert on the thrown value unconditionally
 * afterward instead of nesting `expect` inside a `try`/`catch`
 * (vitest/no-conditional-expect).
 */
export function captureError(fn: () => unknown): unknown {
	try {
		fn()
		return undefined
	} catch (error) {
		return error
	}
}

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
	edits: readonly (readonly [number, number])[],
): Uint8Array {
	const copy = source.slice()
	for (const [offset, value] of edits) copy[offset] = value
	return copy
}

/**
 * Build a minimal RFC 2822 message from `headers` and `body` — each
 * `"Name: value"` line, a blank line, then the body, all CRLF-terminated —
 * returned as bytes via {@link asciiBytes}.
 */
export function buildEml(
	headers: readonly (readonly [string, string])[],
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
