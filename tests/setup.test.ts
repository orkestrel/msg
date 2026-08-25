import { describe, expect, it } from 'vitest'
import {
	asciiBytes,
	buildEml,
	buildNestedMultipart,
	isBrowserVuePath,
	patchBytes,
} from './setup.js'

// `tests/setup.ts` is host-independent, so every contract it exports is reachable from the Node
// environment this project runs in. Each case asserts what the consuming suites rely on and derives
// its expectation by a route the module does not share: `TextEncoder` and `TextDecoder` against the
// hand-rolled byte loop, a `DataView` read against byte-wise edits, and a delimiter scan of the
// decoded text against the multipart builder.

const decoder = new TextDecoder()

describe('asciiBytes', () => {
	it('encodes ASCII text to the same bytes the platform encoder produces', () => {
		expect(asciiBytes('Subject: Quarterly report')).toEqual(
			new TextEncoder().encode('Subject: Quarterly report'),
		)
	})

	it('spends one byte on a latin1 character where UTF-8 would spend two, keeping a wire fixture byte-exact', () => {
		const text = 'café ÿ'
		const bytes = asciiBytes(text)

		expect(bytes.length).toBe(text.length)
		expect(new TextDecoder('latin1').decode(bytes)).toBe(text)
		expect(new TextEncoder().encode(text).length).toBeGreaterThan(bytes.length)
	})
})

// `Buffer` overrides `Uint8Array.prototype.slice` to return a view sharing the source's memory, so
// `patchBytes` constructs its copy instead. These cases assert the copy contract over both the
// `Uint8Array` the signature declares and the `Buffer` a fixture read hands it.
describe('patchBytes', () => {
	it('lands each edit at its own offset and leaves every other byte alone', () => {
		const patched = patchBytes(new Uint8Array(8), [
			[4, 0x78],
			[5, 0x56],
			[6, 0x34],
			[7, 0x12],
		])
		const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength)

		expect(view.getUint32(4, true)).toBe(0x12345678)
		expect(view.getUint32(0, true)).toBe(0)
	})

	it('returns a copy, so the fixture a case patched stays readable at its original bytes', () => {
		const source = new Uint8Array([0x10, 0x20, 0x30])
		const patched = patchBytes(source, [
			[0, 0xff],
			[2, 0xee],
		])

		expect(Array.from(source)).toEqual([0x10, 0x20, 0x30])
		expect(Array.from(patched)).toEqual([0xff, 0x20, 0xee])
		expect(patched.buffer).not.toBe(source.buffer)
	})

	it('copies a Buffer source too, where slice would share the memory it claims to copy', () => {
		const source = Buffer.from([0x10, 0x20, 0x30])
		const patched = patchBytes(source, [[0, 0xff]])

		expect(Array.from(source)).toEqual([0x10, 0x20, 0x30])
		expect(Array.from(patched)).toEqual([0xff, 0x20, 0x30])
	})

	it('anchors the copy at offset 0 over a buffer of its own length, so a reader handed that buffer sees the patched window', () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9])
		const patched = patchBytes(backing.subarray(2, 6), [[1, 0x7f]])

		expect(patched.byteOffset).toBe(0)
		expect(patched.buffer.byteLength).toBe(4)
		expect(Array.from(new Uint8Array(patched.buffer))).toEqual([1, 0x7f, 3, 4])
	})
})

describe('buildEml', () => {
	it('writes CRLF header lines, one blank line, then the body verbatim', () => {
		const body = 'first line\r\nsecond line'
		const bytes = buildEml(
			[
				['Content-Type', 'text/plain'],
				['Subject', 'Quarterly report'],
			],
			body,
		)
		const message = decoder.decode(bytes)
		const separator = message.indexOf('\r\n\r\n')

		expect(message.slice(0, separator).split('\r\n')).toEqual([
			'Content-Type: text/plain',
			'Subject: Quarterly report',
		])
		expect(message.slice(separator + 4)).toBe(body)
		expect(bytes).toEqual(new TextEncoder().encode(message))
	})

	it('inserts a header value verbatim, so a Content-Type carrying a colon, a semicolon and quotes survives', () => {
		const value = 'multipart/mixed; boundary="a:b"; charset="us-ascii"'
		const message = decoder.decode(buildEml([['Content-Type', value]], 'leaf'))

		expect(message.slice(0, message.indexOf('\r\n'))).toBe(`Content-Type: ${value}`)
		expect(message.endsWith('\r\n\r\nleaf')).toBe(true)
	})
})

describe('buildNestedMultipart', () => {
	it('yields a plain text/plain message at depth 0, declaring no boundary', () => {
		expect(decoder.decode(buildNestedMultipart(0))).toBe('Content-Type: text/plain\r\n\r\nleaf')
	})

	it('nests one multipart level per index, level0 outermost, and closes every boundary it declares', () => {
		const message = decoder.decode(buildNestedMultipart(3))

		expect(message.startsWith('Content-Type: multipart/mixed; boundary="level0"\r\n\r\n')).toBe(
			true,
		)
		for (const level of [0, 1, 2]) {
			expect(message.split(`--level${level}\r\n`)).toHaveLength(2)
			expect(message.split(`--level${level}--`)).toHaveLength(2)
		}
		expect(message).toContain('--level2\r\nContent-Type: text/plain\r\n\r\nleaf\r\n--level2--')
		expect(message).not.toContain('level3')
	})

	it('derives every boundary from its level index, so one depth always yields one message', () => {
		const first = buildNestedMultipart(4)
		const second = buildNestedMultipart(4)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})

describe('isBrowserVuePath', () => {
	it('accepts a browser SFC path in either separator family', () => {
		expect(isBrowserVuePath('app/browser/components/MessageList.vue')).toBe(true)
		expect(isBrowserVuePath('app\\browser\\components\\MessageList.vue')).toBe(true)
	})

	it('refuses a sibling environment, a prefix lookalike, and an occurrence below the repository root', () => {
		expect(isBrowserVuePath('app/core/components/MessageList.vue')).toBe(false)
		expect(isBrowserVuePath('app/browserless/components/MessageList.vue')).toBe(false)
		expect(isBrowserVuePath('packages/app/browser/components/MessageList.vue')).toBe(false)
	})
})
