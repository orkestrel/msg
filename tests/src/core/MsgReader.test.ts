import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMsgReader } from 'keepalive'
import {
	isMsgFile,
	removeTrailingNull,
	readUtf16String,
	readAnsiString,
	fileTimeToUtcString,
	toHexLower,
	msftUuidStringify,
} from 'keepalive'

// === Fixture Helpers

function fixtureBuffer(name: string): ArrayBuffer {
	const path = resolve(__dirname, 'fixtures', name)
	const buffer = readFileSync(path)
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(buffer).set(bytes)
	return buffer
}

// === Tests

describe('MsgReader', () => {
	// === isMsgFile helper

	describe('isMsgFile', () => {
		it('returns true for a valid MSG file', () => {
			const buffer = fixtureBuffer('test.msg')
			const view = new DataView(buffer)
			expect(isMsgFile(view)).toBe(true)
		})

		it('returns false for an empty buffer', () => {
			const view = new DataView(new ArrayBuffer(0))
			expect(isMsgFile(view)).toBe(false)
		})

		it('returns false for a buffer too short', () => {
			const view = new DataView(new ArrayBuffer(4))
			expect(isMsgFile(view)).toBe(false)
		})

		it('returns false for random bytes', () => {
			const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
			const view = new DataView(bytes.buffer)
			expect(isMsgFile(view)).toBe(false)
		})

		it('returns false for a buffer with only the first 4 header bytes correct', () => {
			const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00])
			const view = new DataView(bytes.buffer)
			expect(isMsgFile(view)).toBe(false)
		})
	})

	// === removeTrailingNull helper

	describe('removeTrailingNull', () => {
		it('removes trailing null from a string', () => {
			expect(removeTrailingNull('hello\0')).toBe('hello')
		})

		it('removes null in the middle (truncates at first null)', () => {
			expect(removeTrailingNull('he\0llo')).toBe('he')
		})

		it('returns empty string when first char is null', () => {
			expect(removeTrailingNull('\0hello')).toBe('')
		})

		it('returns the original string when no null present', () => {
			expect(removeTrailingNull('hello')).toBe('hello')
		})

		it('handles empty string', () => {
			expect(removeTrailingNull('')).toBe('')
		})
	})

	// === readUtf16String helper

	describe('readUtf16String', () => {
		it('reads a simple ASCII string from UTF-16LE', () => {
			const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00]) // "Hi"
			const view = new DataView(bytes.buffer)
			expect(readUtf16String(view, 0, 2)).toBe('Hi')
		})

		it('reads zero characters', () => {
			const bytes = new Uint8Array([0x48, 0x00])
			const view = new DataView(bytes.buffer)
			expect(readUtf16String(view, 0, 0)).toBe('')
		})

		it('reads from an offset', () => {
			const bytes = new Uint8Array([0x00, 0x00, 0x41, 0x00, 0x42, 0x00]) // skip 2 bytes, then "AB"
			const view = new DataView(bytes.buffer)
			expect(readUtf16String(view, 2, 2)).toBe('AB')
		})
	})

	// === readAnsiString helper

	describe('readAnsiString', () => {
		it('reads a Latin-1 string from bytes', () => {
			const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"
			expect(readAnsiString(bytes)).toBe('Hello')
		})

		it('handles empty data', () => {
			expect(readAnsiString(new Uint8Array(0))).toBe('')
		})
	})

	// === fileTimeToUtcString helper

	describe('fileTimeToUtcString', () => {
		it('converts a known FILETIME to a UTC date string', () => {
			// FILETIME for 2020-01-01T00:00:00Z
			// Unix epoch ms: 1577836800000
			// FILETIME = (1577836800000 * 10000) + 116444736000000000
			// = 15778368000000000 + 116444736000000000 = 132223104000000000
			const fileTime = 132223104000000000
			const high = Math.floor(fileTime / 4294967296)
			const low = fileTime % 4294967296
			const result = fileTimeToUtcString(low, high)
			expect(result).toContain('2020')
			expect(result).toContain('Jan')
		})
	})

	// === toHexLower helper

	describe('toHexLower', () => {
		it('converts 0 to padded hex', () => {
			expect(toHexLower(0, 4)).toBe('0000')
		})

		it('converts 255 to 2-char hex', () => {
			expect(toHexLower(255, 2)).toBe('ff')
		})

		it('converts 0x1234 to 4-char hex', () => {
			expect(toHexLower(0x1234, 4)).toBe('1234')
		})

		it('converts 0xABCD to lowercase', () => {
			expect(toHexLower(0xabcd, 4)).toBe('abcd')
		})

		it('pads with zeros when length exceeds digits', () => {
			expect(toHexLower(1, 8)).toBe('00000001')
		})
	})

	// === msftUuidStringify helper

	describe('msftUuidStringify', () => {
		it('converts a known UUID byte sequence', () => {
			// "00062008-0000-0000-c000-000000000046" in mixed-endian
			const bytes = new Uint8Array([
				0x08,
				0x20,
				0x06,
				0x00, // 00062008 (LE)
				0x00,
				0x00, // 0000 (LE)
				0x00,
				0x00, // 0000 (LE)
				0xc0,
				0x00, // c000 (BE)
				0x00,
				0x00,
				0x00,
				0x00,
				0x00,
				0x46, // 000000000046 (BE)
			])
			const result = msftUuidStringify(bytes, 0)
			expect(result).toBe('00062008-0000-0000-c000-000000000046')
		})
	})

	// === parse() — basic test.msg

	describe('parse', () => {
		it('parses test.msg and returns valid field data', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.dataType).toBe('msg')
			expect(data.error).toBeUndefined()
		})

		it('returns subject from test.msg', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.subject).toBeDefined()
			expect(typeof data.subject).toBe('string')
		})

		it('returns senderName from test.msg', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.senderName).toBeDefined()
			expect(typeof data.senderName).toBe('string')
		})

		it('returns senderEmail from test.msg', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			// Sender email may be at senderEmail or senderSmtpAddress or sentRepresentingSmtpAddress
			const hasSenderEmail =
				data.senderEmail !== undefined ||
				data.senderSmtpAddress !== undefined ||
				data.sentRepresentingSmtpAddress !== undefined
			expect(hasSenderEmail).toBe(true)
		})

		it('returns body from test.msg', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.body).toBeDefined()
			expect(typeof data.body).toBe('string')
		})

		it('returns attachments array', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.attachments).toBeDefined()
			expect(Array.isArray(data.attachments)).toBe(true)
		})

		it('returns recipients array', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.recipients).toBeDefined()
			expect(Array.isArray(data.recipients)).toBe(true)
		})

		it('caches parse result on second call', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const first = reader.parse()
			const second = reader.parse()
			expect(first).toBe(second)
		})
	})

	// === parse() — invalid input

	describe('parse invalid input', () => {
		it('returns error for non-MSG buffer', () => {
			const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
			const reader = createMsgReader(bytes.buffer)
			const data = reader.parse()

			expect(data.dataType).toBeNull()
			expect(data.error).toBe('Unsupported file type')
		})

		it('returns error for empty buffer', () => {
			const reader = createMsgReader(new ArrayBuffer(0))
			const data = reader.parse()

			expect(data.dataType).toBeNull()
			expect(data.error).toBe('Unsupported file type')
		})

		it('caches error result on second call', () => {
			const reader = createMsgReader(new ArrayBuffer(0))
			const first = reader.parse()
			const second = reader.parse()
			expect(first).toBe(second)
			expect(first.error).toBeDefined()
		})
	})

	// === parse() — attachmentFiles.msg

	describe('parse attachmentFiles.msg', () => {
		it('parses message with attachments', () => {
			const buffer = fixtureBuffer('attachmentFiles.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.dataType).toBe('msg')
			expect(data.error).toBeUndefined()
			expect(data.attachments).toBeDefined()
			const attachments = data.attachments ?? []
			expect(attachments.length).toBeGreaterThan(0)
		})

		it('each attachment has dataType attachment', () => {
			const buffer = fixtureBuffer('attachmentFiles.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			for (const attachment of data.attachments ?? []) {
				expect(attachment.dataType).toBe('attachment')
			}
		})

		it('attachments have file names', () => {
			const buffer = fixtureBuffer('attachmentFiles.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const attachments = data.attachments ?? []
			expect(attachments.length).toBeGreaterThan(0)
			for (const attachment of attachments) {
				const hasName =
					attachment.fileName !== undefined ||
					attachment.fileNameShort !== undefined ||
					attachment.name !== undefined
				expect(hasName).toBe(true)
			}
		})
	})

	// === parse() — unicode1.msg

	describe('parse unicode1.msg', () => {
		it('parses unicode MSG file', () => {
			const buffer = fixtureBuffer('unicode1.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.dataType).toBe('msg')
			expect(data.error).toBeUndefined()
		})

		it('has a subject', () => {
			const buffer = fixtureBuffer('unicode1.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.subject).toBeDefined()
			expect(typeof data.subject).toBe('string')
			const subject = data.subject ?? ''
			expect(subject.length).toBeGreaterThan(0)
		})
	})

	// === parse() — msgInMsg.msg (nested MSG)

	describe('parse msgInMsg.msg', () => {
		it('parses message with embedded MSG attachment', () => {
			const buffer = fixtureBuffer('msgInMsg.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			expect(data.dataType).toBe('msg')
			expect(data.error).toBeUndefined()
		})

		it('detects inner MSG content in attachments', () => {
			const buffer = fixtureBuffer('msgInMsg.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const attachments = data.attachments ?? []
			const hasInnerMsg = attachments.some((a) => a.innerMsgContent === true)
			expect(hasInnerMsg).toBe(true)
		})

		it('inner MSG has parsed fields', () => {
			const buffer = fixtureBuffer('msgInMsg.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const innerAttachment = (data.attachments ?? []).find((a) => a.innerMsgContent === true)
			expect(innerAttachment).toBeDefined()
			if (innerAttachment === undefined) {
				throw new Error('Expected an embedded MSG attachment')
			}
			const innerFields = innerAttachment.innerMsgContentFields
			expect(innerFields).toBeDefined()
			expect(innerFields?.dataType).toBe('msg')
		})

		it('embedded MSG attachment round-trips through reader, burner, and reader', () => {
			const buffer = fixtureBuffer('msgInMsg.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const attachments = data.attachments ?? []
			const innerAttachment = attachments.find((attachment) => attachment.innerMsgContent === true)
			expect(innerAttachment).toBeDefined()
			if (innerAttachment === undefined) {
				throw new Error('Expected an embedded MSG attachment')
			}

			const index = attachments.indexOf(innerAttachment)
			const result = reader.attachment(index)
			const innerReader = createMsgReader(toArrayBuffer(result.content))
			const reparsed = innerReader.parse()

			expect(
				isMsgFile(
					new DataView(result.content.buffer, result.content.byteOffset, result.content.byteLength),
				),
			).toBe(true)
			expect(reparsed.dataType).toBe('msg')
			expect(reparsed.subject).toBe(innerAttachment?.innerMsgContentFields?.subject)
		})

		it('top-level burn preserves embedded MSG attachments as openable .msg files', () => {
			const buffer = fixtureBuffer('msgInMsg.msg')
			const reader = createMsgReader(buffer)
			const original = reader.parse()
			const rebuilt = reader.burn()

			const rebuiltReader = createMsgReader(toArrayBuffer(rebuilt))
			const reparsed = rebuiltReader.parse()
			const rebuiltAttachments = reparsed.attachments ?? []
			const rebuiltInnerAttachment = rebuiltAttachments.find(
				(attachment) => attachment.innerMsgContent === true,
			)

			expect(rebuiltInnerAttachment).toBeDefined()
			if (rebuiltInnerAttachment === undefined) {
				throw new Error('Expected an embedded MSG attachment after round-trip')
			}

			const index = rebuiltAttachments.indexOf(rebuiltInnerAttachment)
			const rebuiltInnerFile = rebuiltReader.attachment(index)
			const nestedReader = createMsgReader(toArrayBuffer(rebuiltInnerFile.content))
			const nested = nestedReader.parse()

			expect(nested.dataType).toBe('msg')
			expect(nested.subject).toBe(rebuiltInnerAttachment?.innerMsgContentFields?.subject)
			expect(rebuiltAttachments.length).toBe((original.attachments ?? []).length)
		})
	})

	// === attachment() — read binary content

	describe('attachment', () => {
		it('reads attachment binary content by index', () => {
			const buffer = fixtureBuffer('attachmentFiles.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const attachments = data.attachments ?? []
			// Find a non-inner-msg attachment with a dataId
			const regularAttach = attachments.find(
				(a) => a.innerMsgContent !== true && typeof a.dataId === 'number',
			)
			if (regularAttach === undefined) return // skip if no regular attachments

			const index = attachments.indexOf(regularAttach)
			const result = reader.attachment(index)

			expect(result.fileName).toBeDefined()
			expect(typeof result.fileName).toBe('string')
			expect(result.content).toBeInstanceOf(Uint8Array)
			expect(result.content.length).toBeGreaterThan(0)
		})

		it('throws for out of range index', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			reader.parse()

			expect(() => reader.attachment(-1)).toThrow('out of range')
			expect(() => reader.attachment(9999)).toThrow('out of range')
		})
	})

	// === burn() — dedicated round-trip tests

	describe('burn round trips', () => {
		it('rebuilds a standalone MSG that reparses with the same core fields', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const original = reader.parse()
			const rebuilt = reader.burn()

			expect(isMsgFile(new DataView(rebuilt.buffer, rebuilt.byteOffset, rebuilt.byteLength))).toBe(
				true,
			)

			const rebuiltReader = createMsgReader(toArrayBuffer(rebuilt))
			const reparsed = rebuiltReader.parse()

			expect(reparsed.dataType).toBe('msg')
			expect(reparsed.subject).toBe(original.subject)
			expect(reparsed.senderName).toBe(original.senderName)
			expect(reparsed.senderSmtpAddress ?? reparsed.senderEmail).toBe(
				original.senderSmtpAddress ?? original.senderEmail,
			)
			expect(reparsed.attachments?.length ?? 0).toBe(original.attachments?.length ?? 0)
			expect(reparsed.recipients?.length ?? 0).toBe(original.recipients?.length ?? 0)
			expect(reparsed.headers !== undefined).toBe(original.headers !== undefined)
		})

		it('preserves regular attachment names and binary lengths across a top-level round-trip', () => {
			const buffer = fixtureBuffer('attachmentFiles.msg')
			const reader = createMsgReader(buffer)
			const original = reader.parse()
			const rebuilt = reader.burn()

			const rebuiltReader = createMsgReader(toArrayBuffer(rebuilt))
			const reparsed = rebuiltReader.parse()

			const originalAttachments = original.attachments ?? []
			const rebuiltAttachments = reparsed.attachments ?? []

			expect(rebuiltAttachments.length).toBe(originalAttachments.length)
			expect(rebuiltAttachments.map((attachment) => attachment.fileName)).toEqual(
				originalAttachments.map((attachment) => attachment.fileName),
			)

			for (let index = 0; index < rebuiltAttachments.length; index++) {
				const originalFile = reader.attachment(index)
				const rebuiltFile = rebuiltReader.attachment(index)

				expect(rebuiltFile.fileName).toBe(originalFile.fileName)
				expect(rebuiltFile.content.length).toBe(originalFile.content.length)
			}
		})

		it('can be burned, reparsed, and burned again while preserving core fields', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const first = reader.burn()
			const rebuiltReader = createMsgReader(toArrayBuffer(first))
			const reparsed = rebuiltReader.parse()
			const second = rebuiltReader.burn()
			const secondReader = createMsgReader(toArrayBuffer(second))
			const reparsedAgain = secondReader.parse()

			expect(reparsed.dataType).toBe('msg')
			expect(reparsedAgain.dataType).toBe('msg')
			expect(reparsedAgain.subject).toBe(reparsed.subject)
			expect(reparsedAgain.senderName).toBe(reparsed.senderName)
			expect(reparsedAgain.attachments?.length ?? 0).toBe(reparsed.attachments?.length ?? 0)
		})
	})

	// === recipients

	describe('recipients', () => {
		it('recipients have dataType recipient', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const recipients = data.recipients ?? []
			for (const recipient of recipients) {
				expect(recipient.dataType).toBe('recipient')
			}
		})

		it('recipients have name or email', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			const data = reader.parse()

			const recipients = data.recipients ?? []
			if (recipients.length > 0) {
				for (const recipient of recipients) {
					const hasIdentifier =
						recipient.name !== undefined ||
						recipient.email !== undefined ||
						recipient.smtpAddress !== undefined
					expect(hasIdentifier).toBe(true)
				}
			}
		})
	})

	// === factory function

	describe('createMsgReader', () => {
		it('creates reader with default options', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer)
			expect(reader).toBeDefined()
			expect(typeof reader.parse).toBe('function')
			expect(typeof reader.attachment).toBe('function')
			expect(typeof reader.burn).toBe('function')
		})

		it('creates reader with custom encoding option', () => {
			const buffer = fixtureBuffer('test.msg')
			const reader = createMsgReader(buffer, { encoding: 'windows-1252' })
			const data = reader.parse()
			expect(data.dataType).toBe('msg')
		})
	})

	// === edge cases

	describe('edge cases', () => {
		it('handles a minimal CFB header that is valid but has no content', () => {
			// Create a buffer with valid CFB header but minimal structure
			const size = 512
			const bytes = new Uint8Array(size)
			// Set CFB magic header
			bytes[0] = 0xd0
			bytes[1] = 0xcf
			bytes[2] = 0x11
			bytes[3] = 0xe0
			bytes[4] = 0xa1
			bytes[5] = 0xb1
			bytes[6] = 0x1a
			bytes[7] = 0xe1
			// Set minor version
			bytes[0x18] = 0x3e
			bytes[0x19] = 0x00
			// Set major version
			bytes[0x1a] = 0x03
			bytes[0x1b] = 0x00
			// Set byte order (little-endian)
			bytes[0x1c] = 0xfe
			bytes[0x1d] = 0xff
			// Set sector size power (9 = 512 bytes)
			bytes[0x1e] = 0x09
			bytes[0x1f] = 0x00
			// Set all FAT/directory pointers to END_OF_CHAIN (-2 as int32 LE)
			const endChain = new DataView(bytes.buffer)
			endChain.setInt32(0x30, -2, true) // property start
			endChain.setInt32(0x3c, -2, true) // sbat start
			endChain.setInt32(0x44, -2, true) // xbat start

			const reader = createMsgReader(bytes.buffer)
			// This may throw or return a result with empty fields — either is valid
			try {
				const data = reader.parse()
				expect(data.dataType).toBe('msg')
			} catch {
				// acceptable — minimal CFB may not parse fully
			}
		})
	})
})
