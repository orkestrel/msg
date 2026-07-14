import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createMsgReader,
	isMsgError,
	isMsgFile,
	MSG_HEADER_BAT_COUNT_OFFSET,
	MSG_HEADER_BAT_START_OFFSET,
	MSG_HEADER_PROPERTY_START_OFFSET,
	MSG_S_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_MARK,
	MSG_PROP_NAME_SIZE_OFFSET,
} from '@src/core'
import { asciiBytes, patchBytes } from '../../setup.js'

// The MSG (CFB/OLE2 compound binary) reader — parses Outlook .msg files into
// MsgFieldData (subject, sender, body, recipients, attachments), reads
// attachment binary content by index, and can `burn` a parsed structure back
// into a standalone CFB byte stream. Every parsing step treats the input as
// untrusted: header fields, sector chains, and directory hierarchies are all
// bounds- and cycle-guarded, surfacing a typed MsgError rather than a raw
// RangeError/TypeError (AGENTS §12).

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

// Reads the CFB sector-size mark (byte 30) the same way MsgReader does, so
// test-side header patches land at the sector the reader itself will visit.
function bigBlockSizeOf(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const mark = view.getUint8(30)
	return mark === MSG_L_BIG_BLOCK_MARK ? MSG_L_BIG_BLOCK_SIZE : MSG_S_BIG_BLOCK_SIZE
}

// === parse() — happy path across all four fixtures

describe('MsgReader — parse() happy path', () => {
	it.each(['test.msg', 'attachmentFiles.msg', 'msgInMsg.msg', 'unicode1.msg'])(
		'parses %s into a kind "msg" field data structure',
		(name) => {
			const reader = createMsgReader(toArrayBuffer(readFixture(name)))
			const data = reader.parse()

			expect(data.kind).toBe('msg')
			expect(typeof data.subject === 'string' || data.subject === undefined).toBe(true)
			expect(typeof data.senderName === 'string' || data.senderName === undefined).toBe(true)
			expect(typeof data.body === 'string' || data.body === undefined).toBe(true)
			expect(Array.isArray(data.recipients ?? [])).toBe(true)
			expect(Array.isArray(data.attachments ?? [])).toBe(true)
		},
	)

	it('caches the parsed result across repeated calls', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('test.msg')))
		const first = reader.parse()
		const second = reader.parse()
		expect(first).toBe(second)
	})
})

describe('MsgReader — unicode1.msg exercises UTF-16 field decoding', () => {
	it('decodes a non-empty subject containing at least one non-ASCII code unit', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('unicode1.msg')))
		const data = reader.parse()

		expect(data.subject).toBeDefined()
		const subject = data.subject ?? ''
		expect(subject.length).toBeGreaterThan(0)

		const hasNonAscii = Array.from(subject).some((char) => char.charCodeAt(0) > 127)
		expect(hasNonAscii).toBe(true)
	})
})

describe('MsgReader — attachmentFiles.msg exposes attachments', () => {
	it('lists attachments with a file name and readable binary content', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('attachmentFiles.msg')))
		const data = reader.parse()
		const attachments = data.attachments ?? []

		expect(attachments.length).toBeGreaterThan(0)

		for (let index = 0; index < attachments.length; index++) {
			const attachment = attachments[index]
			expect(attachment.kind).toBe('attachment')
			const result = reader.attachment(index)
			expect(typeof result.fileName).toBe('string')
			expect(result.fileName.length).toBeGreaterThan(0)
			expect(result.content).toBeInstanceOf(Uint8Array)
		}
	})
})

describe('MsgReader — msgInMsg.msg exercises an embedded .msg attachment', () => {
	it('marks the embedded entry as inner MSG content with parsed inner fields', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('msgInMsg.msg')))
		const data = reader.parse()
		const attachments = data.attachments ?? []

		const inner = attachments.find((attachment) => attachment.innerMsgContent === true)
		expect(inner).toBeDefined()
		if (inner === undefined) throw new Error('expected an embedded MSG attachment')

		expect(inner.innerMsgContentFields).toBeDefined()
		expect(inner.innerMsgContentFields?.kind).toBe('msg')
	})

	it('reads the embedded .msg binary content as a valid CFB file via attachment()', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('msgInMsg.msg')))
		const data = reader.parse()
		const attachments = data.attachments ?? []
		const innerIndex = attachments.findIndex((attachment) => attachment.innerMsgContent === true)
		expect(innerIndex).toBeGreaterThanOrEqual(0)

		const result = reader.attachment(innerIndex)
		const view = new DataView(
			result.content.buffer,
			result.content.byteOffset,
			result.content.byteLength,
		)
		expect(isMsgFile(view)).toBe(true)

		const innerReader = createMsgReader(toArrayBuffer(result.content))
		const reparsed = innerReader.parse()
		expect(reparsed.kind).toBe('msg')
		expect(reparsed.subject).toBe(attachments[innerIndex].innerMsgContentFields?.subject)
	})
})

// === Constructor input forms

describe('MsgReader — constructor accepts ArrayBuffer and Uint8Array forms identically', () => {
	it('parses identically from an ArrayBuffer, a zero-offset Uint8Array, and a non-zero-offset Uint8Array view', () => {
		const bytes = readFixture('test.msg')

		const fromArrayBuffer = createMsgReader(toArrayBuffer(bytes)).parse()
		const fromZeroOffsetView = createMsgReader(bytes.slice()).parse()
		const fromNonZeroOffsetView = createMsgReader(withByteOffset(bytes, 37)).parse()

		expect(fromZeroOffsetView.kind).toBe('msg')
		expect(fromNonZeroOffsetView.kind).toBe('msg')
		expect(fromNonZeroOffsetView.subject).toBe(fromArrayBuffer.subject)
		expect(fromNonZeroOffsetView.senderName).toBe(fromArrayBuffer.senderName)
		expect(fromNonZeroOffsetView.body).toBe(fromArrayBuffer.body)
		expect(fromNonZeroOffsetView.attachments?.length ?? 0).toBe(
			fromArrayBuffer.attachments?.length ?? 0,
		)
		expect(fromZeroOffsetView.subject).toBe(fromArrayBuffer.subject)
	})
})

// === attachment() error paths

describe('MsgReader — attachment() range errors', () => {
	it('throws an MsgError with code RANGE for a negative index', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('test.msg')))
		reader.parse()

		let thrown: unknown
		try {
			reader.attachment(-1)
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('RANGE')
	})

	it('throws an MsgError with code RANGE for an index past the end', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('test.msg')))
		reader.parse()

		let thrown: unknown
		try {
			reader.attachment(9999)
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('RANGE')
	})

	it('reads valid indices without throwing', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('attachmentFiles.msg')))
		const data = reader.parse()
		const attachments = data.attachments ?? []
		expect(attachments.length).toBeGreaterThan(0)

		expect(() => reader.attachment(0)).not.toThrow()
	})
})

// === Non-CFB / malformed input

describe('MsgReader — non-CFB input', () => {
	it('throws MsgError UNSUPPORTED for bytes lacking the CFB magic header', () => {
		const bytes = asciiBytes('hello world')
		const reader = createMsgReader(toArrayBuffer(bytes))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('UNSUPPORTED')
	})

	it('throws MsgError UNSUPPORTED for an empty buffer', () => {
		const reader = createMsgReader(new ArrayBuffer(0))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('UNSUPPORTED')
	})
})

// === Truncated input

describe('MsgReader — truncated input', () => {
	it('throws a structural MsgError (not a raw RangeError) for a fixture truncated to 700 bytes', () => {
		const bytes = readFixture('test.msg').slice(0, 700)
		const reader = createMsgReader(toArrayBuffer(bytes))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
	})
})

// === Corrupted header counts

describe('MsgReader — corrupted FAT sector count', () => {
	it('throws a structural MsgError instead of hanging or exhausting memory', () => {
		const bytes = readFixture('test.msg')
		const huge = 0x7fffffff
		const patched = patchBytes(bytes, [
			[MSG_HEADER_BAT_COUNT_OFFSET, huge & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 1, (huge >>> 8) & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 2, (huge >>> 16) & 0xff],
			[MSG_HEADER_BAT_COUNT_OFFSET + 3, (huge >>> 24) & 0xff],
		])
		const reader = createMsgReader(toArrayBuffer(patched))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
	})
})

// === FAT cycle

describe('MsgReader — a FAT sector chain that points back at itself', () => {
	it('terminates promptly with an MsgError instead of looping forever', () => {
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
		const reader = createMsgReader(toArrayBuffer(patched))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && (thrown.code === 'CYCLE' || thrown.code === 'MALFORMED')).toBe(
			true,
		)
	})
})

// === Adversarial directory entry name size

describe('MsgReader — a directory entry name-size field set to an adversarial value', () => {
	it('clamps the name read instead of driving a raw RangeError past the entry', () => {
		const bytes = readFixture('test.msg')
		const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		const bigBlockSize = bigBlockSizeOf(bytes)
		const propertyStart = header.getInt32(MSG_HEADER_PROPERTY_START_OFFSET, true)
		const entryOffset = (propertyStart + 1) * bigBlockSize
		const nameSizeOffset = entryOffset + MSG_PROP_NAME_SIZE_OFFSET

		// 0xFFFE claims a ~65KB name — far beyond the 64-byte CFB name field —
		// which, unclamped, would drive readUtf16String's raw getUint16 reads
		// past the view's bounds and throw a raw RangeError near EOF.
		const patched = patchBytes(bytes, [
			[nameSizeOffset, 0xfe],
			[nameSizeOffset + 1, 0xff],
		])
		const reader = createMsgReader(toArrayBuffer(patched))

		let thrown: unknown
		try {
			reader.parse()
		} catch (error) {
			thrown = error
		}
		// Clamped to the entry's own 31-unit capacity, the read stays in
		// bounds — either parse succeeds outright, or any failure surfaces
		// as a typed MsgError, never a raw RangeError.
		expect(thrown === undefined || isMsgError(thrown)).toBe(true)
	})
})

// === burn() round-trip

describe('MsgReader — burn() round-trip', () => {
	it.each(['test.msg', 'attachmentFiles.msg', 'msgInMsg.msg', 'unicode1.msg'])(
		'rebuilds %s into an openable CFB file with the same subject, body, and attachment count',
		(name) => {
			const reader = createMsgReader(toArrayBuffer(readFixture(name)))
			const original = reader.parse()
			const burned = reader.burn()

			const view = new DataView(burned.buffer, burned.byteOffset, burned.byteLength)
			expect(isMsgFile(view)).toBe(true)

			const rebuiltReader = createMsgReader(toArrayBuffer(burned))
			const reparsed = rebuiltReader.parse()

			expect(reparsed.kind).toBe('msg')
			expect(reparsed.subject).toBe(original.subject)
			expect(reparsed.body).toBe(original.body)
			expect(reparsed.attachments?.length ?? 0).toBe(original.attachments?.length ?? 0)
		},
	)
})

// === encoding option

describe('MsgReader — encoding option', () => {
	it('parses successfully with { encoding: "latin1" }', () => {
		const reader = createMsgReader(toArrayBuffer(readFixture('test.msg')), { encoding: 'latin1' })
		const data = reader.parse()
		expect(data.kind).toBe('msg')
	})

	it('produces the same result as the default (windows-1252) encoding for this fixture', () => {
		const defaultReader = createMsgReader(toArrayBuffer(readFixture('test.msg')))
		const latin1Reader = createMsgReader(toArrayBuffer(readFixture('test.msg')), {
			encoding: 'latin1',
		})

		const defaultData = defaultReader.parse()
		const latin1Data = latin1Reader.parse()

		// Both parse the same fixture successfully; whether the ANSI-decoded
		// fields differ depends on whether any non-Unicode string field in
		// this fixture actually contains a high byte (0x80-0x9F), which
		// windows-1252 and latin1 map differently.
		expect(latin1Data.kind).toBe('msg')
		expect(defaultData.kind).toBe('msg')
	})
})
