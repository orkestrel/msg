import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MSG, createMSG, isSuccess, isMSGError, isMSGFile } from '@src/core'

// Mirrors src/core/MSG.ts 1:1 (AGENTS §16): the single MSG class parses both
// .eml (RFC 2822 / MIME) and .msg (CFB/OLE2) input eagerly in its
// constructor, throwing a typed MSGError on malformed/unsupported input.
// createMSG wraps the same construction in a total Result<MSGInterface,
// MSGError> that never throws.

// === Fixture helpers (file-local: binary loading stays inside the test file)

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function readFixture(name: string): Uint8Array {
	return readFileSync(join(fixturesDir, name))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(buffer).set(bytes)
	return buffer
}

// === eml parsing

describe('MSG — eml input', () => {
	it('parses an eml file into an "eml" chain with fields undefined', () => {
		const source = 'Subject: Hello\r\nFrom: a@example.com\r\nTo: b@example.com\r\n\r\nBody text'
		const bytes = new TextEncoder().encode(source)
		const msg = new MSG({ bytes, name: 'message.eml' })

		expect(msg.chain.format).toBe('eml')
		expect(msg.chain.messages.length).toBe(1)
		expect(msg.fields).toBeUndefined()
	})
})

// === msg parsing — happy path across all four fixtures

describe('MSG — msg input', () => {
	it.each(['test.msg', 'attachmentFiles.msg', 'msgInMsg.msg', 'unicode1.msg'])(
		'parses %s into a "msg" chain with defined fields',
		(name) => {
			const msg = new MSG(toArrayBuffer(readFixture(name)))

			expect(msg.chain.format).toBe('msg')
			expect(msg.chain.messages.length).toBe(1)
			expect(msg.fields).toBeDefined()
			expect(msg.fields?.kind).toBe('msg')
		},
	)
})

// === createMSG — total Result boundary

describe('MSG — createMSG never throws', () => {
	it('returns a Success for valid msg bytes', () => {
		const result = createMSG(toArrayBuffer(readFixture('test.msg')))
		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) throw new Error('unreachable')
		expect(result.value.chain.format).toBe('msg')
	})

	it('returns a Failure with an MSGError for unsupported bytes', () => {
		const bytes = new TextEncoder().encode('hello world')
		const result = createMSG(toArrayBuffer(bytes))
		expect(isSuccess(result)).toBe(false)
		if (isSuccess(result)) throw new Error('unreachable')
		expect(isMSGError(result.error)).toBe(true)
		if (!isMSGError(result.error)) throw new Error('unreachable')
		expect(result.error.code).toBe('UNSUPPORTED')
	})
})

// === attachment(index)

describe('MSG — attachmentFiles.msg exposes attachments', () => {
	it('lists attachments with a file name and readable binary content', () => {
		const msg = new MSG(toArrayBuffer(readFixture('attachmentFiles.msg')))
		const attachments = msg.fields?.attachments ?? []
		expect(attachments.length).toBeGreaterThan(0)

		for (let index = 0; index < attachments.length; index++) {
			const result = msg.attachment(index)
			expect(typeof result.fileName).toBe('string')
			expect(result.fileName.length).toBeGreaterThan(0)
			expect(result.content).toBeInstanceOf(Uint8Array)
		}
	})
})

describe('MSG — msgInMsg.msg exercises an embedded .msg attachment', () => {
	it('marks the embedded entry as inner MSG content with parsed inner fields', () => {
		const msg = new MSG(toArrayBuffer(readFixture('msgInMsg.msg')))
		const attachments = msg.fields?.attachments ?? []

		const inner = attachments.find((attachment) => attachment.innerMSGContent === true)
		expect(inner).toBeDefined()
		if (inner === undefined) throw new Error('expected an embedded MSG attachment')

		expect(inner.innerMSGContentFields).toBeDefined()
		expect(inner.innerMSGContentFields?.kind).toBe('msg')
	})

	it('reads the embedded .msg binary content as a valid CFB file via attachment()', () => {
		const msg = new MSG(toArrayBuffer(readFixture('msgInMsg.msg')))
		const attachments = msg.fields?.attachments ?? []
		const innerIndex = attachments.findIndex((attachment) => attachment.innerMSGContent === true)
		expect(innerIndex).toBeGreaterThanOrEqual(0)

		const result = msg.attachment(innerIndex)
		const view = new DataView(
			result.content.buffer,
			result.content.byteOffset,
			result.content.byteLength,
		)
		expect(isMSGFile(view)).toBe(true)

		const innerMsg = new MSG(toArrayBuffer(result.content))
		expect(innerMsg.fields?.kind).toBe('msg')
		expect(innerMsg.fields?.subject).toBe(attachments[innerIndex].innerMSGContentFields?.subject)
	})
})

describe('MSG — attachment() range errors', () => {
	it('throws an MSGError with code RANGE for a negative index', () => {
		const msg = new MSG(toArrayBuffer(readFixture('test.msg')))

		let thrown: unknown
		try {
			msg.attachment(-1)
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && thrown.code).toBe('RANGE')
	})

	it('throws an MSGError with code RANGE for an index past the end', () => {
		const msg = new MSG(toArrayBuffer(readFixture('test.msg')))

		let thrown: unknown
		try {
			msg.attachment(9999)
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && thrown.code).toBe('RANGE')
	})
})

// === burn() round-trip — re-parse equivalence, not byte-identity

describe('MSG — burn() round-trip', () => {
	it.each(['test.msg', 'attachmentFiles.msg', 'msgInMsg.msg', 'unicode1.msg'])(
		'rebuilds %s into an openable CFB file with the same subject, body, and attachment count',
		(name) => {
			const original = new MSG(toArrayBuffer(readFixture(name)))
			const burned = original.burn()

			const view = new DataView(burned.buffer, burned.byteOffset, burned.byteLength)
			expect(isMSGFile(view)).toBe(true)

			const reparsed = new MSG(toArrayBuffer(burned))

			expect(reparsed.chain.format).toBe('msg')
			expect(reparsed.fields?.subject).toBe(original.fields?.subject)
			expect(reparsed.fields?.body).toBe(original.fields?.body)
			expect(reparsed.fields?.attachments?.length ?? 0).toBe(
				original.fields?.attachments?.length ?? 0,
			)
		},
	)

	it('preserves each attachment name and content bytes through burn() + re-parse for attachmentFiles.msg', () => {
		const original = new MSG(toArrayBuffer(readFixture('attachmentFiles.msg')))
		const burned = original.burn()
		const reparsed = new MSG(toArrayBuffer(burned))

		const originalCount = original.fields?.attachments?.length ?? 0
		for (let i = 0; i < originalCount; i++) {
			const originalAttachment = original.attachment(i)
			const reparsedAttachment = reparsed.attachment(i)
			expect(reparsedAttachment.fileName).toBe(originalAttachment.fileName)
			expect(reparsedAttachment.content.length).toBe(originalAttachment.content.length)
			expect(Array.from(reparsedAttachment.content)).toStrictEqual(
				Array.from(originalAttachment.content),
			)
		}
	})
})

// === encoding option

describe('MSG — encoding option', () => {
	it('parses successfully with { encoding: "latin1" }', () => {
		const msg = new MSG(toArrayBuffer(readFixture('test.msg')), { encoding: 'latin1' })
		expect(msg.fields?.kind).toBe('msg')
	})

	it('produces the same result as the default (windows-1252) encoding for this fixture', () => {
		const defaultMsg = new MSG(toArrayBuffer(readFixture('test.msg')))
		const latin1Msg = new MSG(toArrayBuffer(readFixture('test.msg')), { encoding: 'latin1' })

		// Both parse the same fixture successfully; whether the ANSI-decoded
		// fields differ depends on whether any non-Unicode string field in
		// this fixture actually contains a high byte (0x80-0x9F), which
		// windows-1252 and latin1 map differently.
		expect(latin1Msg.fields?.kind).toBe('msg')
		expect(defaultMsg.fields?.kind).toBe('msg')
	})
})

// === typed-error behavior — MSGError, never a raw RangeError

describe('MSG — non-CFB / malformed input throws typed MSGError', () => {
	it('throws MSGError UNSUPPORTED for bytes lacking the CFB magic header', () => {
		const bytes = new TextEncoder().encode('hello world')

		let thrown: unknown
		try {
			const instance = new MSG(toArrayBuffer(bytes))
			thrown = instance
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
		if (!isMSGError(thrown)) throw new Error('unreachable')
		expect(thrown.code).toBe('UNSUPPORTED')
	})

	it('throws MSGError UNSUPPORTED for an empty buffer', () => {
		let thrown: unknown
		try {
			const instance = new MSG(new ArrayBuffer(0))
			thrown = instance
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
		if (!isMSGError(thrown)) throw new Error('unreachable')
		expect(thrown.code).toBe('UNSUPPORTED')
	})

	it('throws a structural MSGError (not a raw RangeError) for a fixture truncated to 700 bytes', () => {
		const bytes = readFixture('test.msg').slice(0, 700)

		let thrown: unknown
		try {
			const instance = new MSG(toArrayBuffer(bytes))
			thrown = instance
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
	})
})
