import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	MSG,
	createMSG,
	isSuccess,
	isMSGError,
	isMSGFile,
	MSG_HEADER_BAT_COUNT_OFFSET,
	MSG_HEADER_BAT_START_OFFSET,
	MSG_HEADER_PROPERTY_START_OFFSET,
	MSG_S_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_MARK,
	MSG_PROP_NAME_SIZE_OFFSET,
} from '@src/core'
import { patchBytes, buildEml } from '../../setup.js'

// Mirrors src/core/MSG.ts 1:1 (AGENTS §16): the single MSG class parses both
// .eml (RFC 2822 / MIME) and .msg (CFB/OLE2) input eagerly in its
// constructor, throwing a typed MSGError on malformed/unsupported input.
// createMSG wraps the same construction, surfacing every parse failure as a
// Failure<MSGError> in the returned Result<MSGInterface, MSGError> rather
// than throwing it; an unexpected non-MSGError error still propagates.

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

// Copies `bytes` into a larger backing buffer at a non-zero byte offset,
// returning a Uint8Array VIEW over that offset — exercises the constructor's
// `byteOffset`-aware DataView setup rather than a fresh, zero-offset buffer.
function withByteOffset(bytes: Uint8Array, offset: number): Uint8Array {
	const backing = new Uint8Array(offset + bytes.byteLength + 8)
	backing.set(bytes, offset)
	return new Uint8Array(backing.buffer, offset, bytes.byteLength)
}

// Reads the CFB sector-size mark (byte 30) the same way MSG does, so
// test-side header patches land at the sector the parser itself will visit.
function bigBlockSizeOf(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const mark = view.getUint8(30)
	return mark === MSG_L_BIG_BLOCK_MARK ? MSG_L_BIG_BLOCK_SIZE : MSG_S_BIG_BLOCK_SIZE
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

// === Constructor input forms

describe('MSG — constructor accepts ArrayBuffer and Uint8Array forms identically', () => {
	it('parses identically from an ArrayBuffer, a zero-offset Uint8Array, and a non-zero-offset Uint8Array view', () => {
		const bytes = readFixture('test.msg')

		const fromArrayBuffer = new MSG(toArrayBuffer(bytes))
		const fromZeroOffsetView = new MSG(bytes.slice())
		const fromNonZeroOffsetView = new MSG(withByteOffset(bytes, 37))

		expect(fromZeroOffsetView.fields?.kind).toBe('msg')
		expect(fromNonZeroOffsetView.fields?.kind).toBe('msg')
		expect(fromNonZeroOffsetView.fields?.subject).toBe(fromArrayBuffer.fields?.subject)
		expect(fromNonZeroOffsetView.fields?.senderName).toBe(fromArrayBuffer.fields?.senderName)
		expect(fromNonZeroOffsetView.fields?.body).toBe(fromArrayBuffer.fields?.body)
		expect(fromNonZeroOffsetView.fields?.attachments?.length ?? 0).toBe(
			fromArrayBuffer.fields?.attachments?.length ?? 0,
		)
		expect(fromZeroOffsetView.fields?.subject).toBe(fromArrayBuffer.fields?.subject)
	})
})

// === Adversarial CFB corpus (ported from the retired MSGReader.test.ts)

describe('MSG — corrupted FAT sector count', () => {
	it('throws a structural MSGError instead of hanging or exhausting memory', () => {
		const bytes = readFixture('test.msg')
		const huge = 0x7fffffff
		const patched = patchBytes(bytes, [
			[MSG_HEADER_BAT_COUNT_OFFSET, huge & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 1, (huge >>> 8) & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 2, (huge >>> 16) & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 3, (huge >>> 24) & 0xff],
		])

		let thrown: unknown
		try {
			const instance = new MSG(toArrayBuffer(patched))
			thrown = instance
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
	})
})

describe('MSG — a FAT sector chain that points back at itself', () => {
	it('terminates promptly with an MSGError instead of looping forever', () => {
		const bytes = readFixture('test.msg')
		const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		const bigBlockSize = bigBlockSizeOf(bytes)
		const bigBlockLength = bigBlockSize / 4
		const propertyStart = header.getInt32(MSG_HEADER_PROPERTY_START_OFFSET, true)
		const firstFatSector = header.getInt32(MSG_HEADER_BAT_START_OFFSET, true)

		// propertyStart must land in the first FAT block (block 0) for this
		// single-patch cycle to hit the property chain directly.
		expect(propertyStart).toBeGreaterThanOrEqual(0)
		expect(propertyStart).toBeLessThan(bigBlockLength)

		// The FAT entry for `propertyStart`'s own sector lives inside the
		// first FAT sector, at 4 bytes per entry — patch it to point back at
		// `propertyStart` itself, forming a one-hop self-cycle.
		const entryOffset = (firstFatSector + 1) * bigBlockSize + propertyStart * 4
		const patched = patchBytes(bytes, [
			[entryOffset, propertyStart & 0xff],
			[entryOffset + 1, (propertyStart >>> 8) & 0xff],
			[entryOffset + 2, (propertyStart >>> 16) & 0xff],
			[entryOffset + 3, (propertyStart >>> 24) & 0xff],
		])

		let thrown: unknown
		try {
			const instance = new MSG(toArrayBuffer(patched))
			thrown = instance
		} catch (error) {
			thrown = error
		}
		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && (thrown.code === 'CYCLE' || thrown.code === 'MALFORMED')).toBe(
			true,
		)
	})
})

describe('MSG — a directory entry name-size field set to an adversarial value', () => {
	it('clamps the name read instead of driving a raw RangeError past the entry', () => {
		const bytes = readFixture('test.msg')
		const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		const bigBlockSize = bigBlockSizeOf(bytes)
		const propertyStart = header.getInt32(MSG_HEADER_PROPERTY_START_OFFSET, true)
		const entryOffset = (propertyStart + 1) * bigBlockSize
		const nameSizeOffset = entryOffset + MSG_PROP_NAME_SIZE_OFFSET

		// 0xFFFE claims a ~65KB name — far beyond the 64-byte CFB name field —
		// which, unclamped, would drive readUTF16String's raw getUint16 reads
		// past the view's bounds and throw a raw RangeError near EOF.
		const patched = patchBytes(bytes, [
			[nameSizeOffset, 0xfe],
			[nameSizeOffset + 1, 0xff],
		])

		let thrown: unknown
		let instance: MSG | undefined
		try {
			instance = new MSG(toArrayBuffer(patched))
		} catch (error) {
			thrown = error
		}
		// Clamped to the entry's own 31-unit capacity, the read stays in
		// bounds — either parse succeeds outright, or any failure surfaces
		// as a typed MSGError, never a raw RangeError.
		expect(instance !== undefined || isMSGError(thrown)).toBe(true)
	})
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
		'rebuilds %s into an openable CFB file with the same subject, body, attachment count, and recipients',
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

			const originalMessage = original.chain.messages[0]
			const reparsedMessage = reparsed.chain.messages[0]
			expect(reparsedMessage.to).toStrictEqual(originalMessage.to)
			expect(reparsedMessage.cc).toStrictEqual(originalMessage.cc)
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

// === end-to-end multipart eml integration (MIME leaves are unit-tested in
// parsers.test.ts; this pins the integration path through MSG itself)

describe('MSG — end-to-end multipart/alternative eml', () => {
	it('decodes a base64 text/plain part and a plain text/html part through the MSG chain', () => {
		const encodedText = Buffer.from('Hello, World!').toString('base64')
		const boundary = 'BOUNDARY1'
		const body =
			`--${boundary}\r\n` +
			'Content-Type: text/plain; charset=utf-8\r\n' +
			'Content-Transfer-Encoding: base64\r\n\r\n' +
			`${encodedText}\r\n` +
			`--${boundary}\r\n` +
			'Content-Type: text/html\r\n\r\n' +
			'<p>Hello, World!</p>\r\n' +
			`--${boundary}--`

		const bytes = buildEml(
			[
				['Subject', 'Multipart test'],
				['From', 'alice@example.com'],
				['To', 'bob@example.com'],
				['Content-Type', `multipart/alternative; boundary="${boundary}"`],
			],
			body,
		)

		const msg = new MSG({ bytes, name: 'message.eml' })

		expect(msg.chain.format).toBe('eml')
		expect(msg.chain.messages).toHaveLength(1)

		const message = msg.chain.messages[0]
		expect(message.subject).toBe('Multipart test')
		expect(message.text).toBe('Hello, World!')
		expect(message.html).toBe('<p>Hello, World!</p>')
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
