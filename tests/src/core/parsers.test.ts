import { describe, it, expect } from 'vitest'
import {
	detectFormat,
	parseMIMEPart,
	extractMessage,
	extractMessageFromMSG,
	isMSGFile,
	decodeUTF8,
} from '@src/core'
import type { EmailMessage, MSGFieldData } from '@src/core'
import { asciiBytes, buildEml } from '../../setup.js'

// parsers.ts holds the extracted leaf functions consumed by MSG.ts's
// construction path: format sniffing, MIME parsing, message extraction
// (from both a MIME tree and a parsed MSG field tree), CFB magic detection,
// and the pure-ES UTF-8 decoder. Each leaf is unit-tested in isolation here;
// full end-to-end parsing behavior lives in MSG.test.ts.

describe('detectFormat', () => {
	it('detects eml from a .eml filename', () => {
		expect(detectFormat('message.eml', undefined)).toBe('eml')
		expect(detectFormat('MESSAGE.EML', undefined)).toBe('eml')
	})

	it('detects msg from a .msg filename', () => {
		expect(detectFormat('message.msg', undefined)).toBe('msg')
	})

	it('detects eml from a message/rfc822 mime type', () => {
		expect(detectFormat(undefined, 'message/rfc822')).toBe('eml')
	})

	it('detects msg from an application/vnd.ms-outlook mime type', () => {
		expect(detectFormat(undefined, 'application/vnd.ms-outlook')).toBe('msg')
	})

	it('prefers the filename extension over the mime type', () => {
		expect(detectFormat('message.eml', 'application/vnd.ms-outlook')).toBe('eml')
	})

	it('returns undefined when neither hint resolves', () => {
		expect(detectFormat(undefined, undefined)).toBeUndefined()
		expect(detectFormat('message.txt', 'text/plain')).toBeUndefined()
	})
})

describe('parseMIMEPart', () => {
	it('parses a small multipart message into its child parts', () => {
		const raw = decodeUTF8(
			buildEml(
				[['Content-Type', 'multipart/mixed; boundary="XYZ"']],
				'--XYZ\r\nContent-Type: text/plain\r\n\r\nHello\r\n--XYZ\r\nContent-Type: text/html\r\n\r\n<p>Hi</p>\r\n--XYZ--',
			),
		)

		const part = parseMIMEPart(raw)

		expect(part.parts).toHaveLength(2)
		expect(part.parts[0]?.body).toBe('Hello')
		expect(part.parts[1]?.body).toBe('<p>Hi</p>')
	})

	it('parses a non-multipart message with an empty parts list', () => {
		const raw = decodeUTF8(buildEml([['Content-Type', 'text/plain']], 'just text'))
		const part = parseMIMEPart(raw)
		expect(part.parts).toEqual([])
		expect(part.body).toBe('just text')
	})
})

describe('extractMessage', () => {
	it('extracts from/to/cc/subject/text from a MIME tree', () => {
		const raw = decodeUTF8(
			buildEml(
				[
					['From', 'Alice <alice@example.com>'],
					['To', 'bob@example.com'],
					['Subject', 'Hello'],
				],
				'Body text',
			),
		)
		const part = parseMIMEPart(raw)
		const message = extractMessage(part)

		expect(message.from).toBe('Alice <alice@example.com>')
		expect(message.to).toEqual(['bob@example.com'])
		expect(message.subject).toBe('Hello')
		expect(message.text).toBe('Body text')
	})
})

describe('extractMessageFromMSG', () => {
	it('extracts a structured EmailMessage from a MSGReaderInterface-shaped reader', () => {
		const fields: MSGFieldData = {
			kind: 'msg',
			subject: 'Hi there',
			senderName: 'Alice',
			senderEmail: 'alice@example.com',
			body: 'plain body',
			recipients: [
				{ kind: 'recipient', name: 'Bob', email: 'bob@example.com', recipientRole: 'to' },
			],
			attachments: [],
		}
		const reader = {
			parse: () => fields,
			attachment: () => {
				throw new Error('no attachments')
			},
		}

		const message: EmailMessage = extractMessageFromMSG(reader)

		expect(message.subject).toBe('Hi there')
		expect(message.from).toBe('Alice <alice@example.com>')
		expect(message.to).toEqual(['Bob <bob@example.com>'])
		expect(message.text).toBe('plain body')
	})

	it('skips an attachment whose extraction throws, without failing the message', () => {
		const fields: MSGFieldData = {
			kind: 'msg',
			subject: 'With attachment',
			attachments: [
				{ kind: 'attachment', fileName: 'broken.bin', mimeType: 'application/octet-stream' },
			],
		}
		const reader = {
			parse: () => fields,
			attachment: () => {
				throw new Error('corrupt stream')
			},
		}

		const message = extractMessageFromMSG(reader)

		expect(message.attachments).toEqual([])
	})
})

describe('isMSGFile', () => {
	it('returns true for the CFB magic header', () => {
		const header = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
		expect(isMSGFile(new DataView(header.buffer))).toBe(true)
	})

	it('returns false for arbitrary ascii bytes', () => {
		const bytes = asciiBytes('not a compound file at all')
		expect(isMSGFile(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toBe(false)
	})
})

describe('decodeUTF8', () => {
	it('round-trips ASCII', () => {
		expect(decodeUTF8(asciiBytes('Hello'))).toBe('Hello')
	})

	it('never throws on invalid bytes — yields U+FFFD', () => {
		expect(decodeUTF8(new Uint8Array([0xff]))).toBe('�')
	})
})
