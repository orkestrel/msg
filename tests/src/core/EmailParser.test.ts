import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createEmailParser,
	createMsgReader,
	detectFormat,
	parseMimePart,
	decodeMimeWords,
	extractMessage,
	extractMessageFromMsg,
	isEmailFormat,
	isUnsupportedFormatError,
	isParseError,
	isEmailParserError,
} from 'keepalive'

// === Helpers

const fixturesDir = join(fileURLToPath(import.meta.url), '../../readers/fixtures')

function makeFile(name: string, content: string, type = ''): File {
	return new File([content], name, { type })
}

function makeBinaryFile(name: string, bytes: Uint8Array, type = ''): File {
	return new File([new Uint8Array(bytes)], name, { type })
}

function loadMsgBuffer(fileName: string): ArrayBuffer {
	const buffer = readFileSync(join(fixturesDir, fileName))
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

// === Fixtures

const PLAIN_EML = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.com>',
	'Subject: Hello',
	'Date: Mon, 01 Jan 2024 12:00:00 +0000',
	'MIME-Version: 1.0',
	'Content-Type: text/plain; charset=utf-8',
	'Content-Transfer-Encoding: 7bit',
	'',
	'Hello, world!',
].join('\r\n')

const MULTIPART_EML = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.com>',
	'Subject: Multipart test',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="boundary123"',
	'',
	'--boundary123',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'See attached.',
	'--boundary123',
	'Content-Type: application/pdf; name="report.pdf"',
	'Content-Disposition: attachment; filename="report.pdf"',
	'Content-Transfer-Encoding: base64',
	'',
	btoa('fake-pdf-bytes'),
	'--boundary123--',
].join('\r\n')

const ALTERNATIVE_EML = [
	'From: sender@example.com',
	'To: recipient@example.com',
	'Subject: Alt test',
	'MIME-Version: 1.0',
	'Content-Type: multipart/alternative; boundary="alt"',
	'',
	'--alt',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Plain text version',
	'--alt',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>HTML version</p>',
	'--alt--',
].join('\r\n')

// === isEmailFormat

describe('isEmailFormat', () => {
	it('returns true for eml', () => {
		expect(isEmailFormat('eml')).toBe(true)
	})

	it('returns true for msg', () => {
		expect(isEmailFormat('msg')).toBe(true)
	})

	it('returns false for unknown string', () => {
		expect(isEmailFormat('pdf')).toBe(false)
	})

	it('returns false for non-string', () => {
		expect(isEmailFormat(42)).toBe(false)
		expect(isEmailFormat(null)).toBe(false)
	})
})

// === detectFormat

describe('detectFormat', () => {
	it('detects .eml by extension', () => {
		expect(detectFormat(makeFile('email.eml', ''))).toBe('eml')
	})

	it('detects .msg by extension', () => {
		expect(detectFormat(makeFile('email.msg', ''))).toBe('msg')
	})

	it('detects eml by MIME type', () => {
		expect(detectFormat(makeFile('email', '', 'message/rfc822'))).toBe('eml')
	})

	it('detects msg by MIME type', () => {
		expect(detectFormat(makeFile('email', '', 'application/vnd.ms-outlook'))).toBe('msg')
	})

	it('returns undefined for unknown format', () => {
		expect(detectFormat(makeFile('file.txt', ''))).toBeUndefined()
	})

	it('is case-insensitive for extension', () => {
		expect(detectFormat(makeFile('EMAIL.EML', ''))).toBe('eml')
		expect(detectFormat(makeFile('FILE.MSG', ''))).toBe('msg')
	})
})

// === parseMimePart

describe('parseMimePart', () => {
	it('parses headers correctly', () => {
		const part = parseMimePart(PLAIN_EML)
		expect(part.headers.get('from')?.value).toBe('Alice <alice@example.com>')
		expect(part.headers.get('subject')?.value).toBe('Hello')
	})

	it('handles CRLF and LF line endings', () => {
		const lf = PLAIN_EML.replace(/\r\n/g, '\n')
		const part = parseMimePart(lf)
		expect(part.headers.get('from')?.value).toBe('Alice <alice@example.com>')
	})

	it('parses content-type parameters', () => {
		const part = parseMimePart(PLAIN_EML)
		expect(part.headers.get('content-type')?.params.get('charset')).toBe('utf-8')
	})

	it('parses multipart boundary from content-type', () => {
		const part = parseMimePart(MULTIPART_EML)
		expect(part.headers.get('content-type')?.params.get('boundary')).toBe('boundary123')
	})

	it('splits multipart into child parts', () => {
		const part = parseMimePart(MULTIPART_EML)
		expect(part.parts).toHaveLength(2)
	})

	it('returns empty parts for non-multipart', () => {
		const part = parseMimePart(PLAIN_EML)
		expect(part.parts).toHaveLength(0)
	})

	it('handles missing final boundary gracefully', () => {
		const noFinal = MULTIPART_EML.replace('--boundary123--', '--boundary123')
		const part = parseMimePart(noFinal)
		expect(part.parts.length).toBeGreaterThan(0)
	})

	it('handles folded headers', () => {
		const folded = ['Subject: This is a very', ' long subject line', '', 'Body'].join('\n')
		const part = parseMimePart(folded)
		expect(part.headers.get('subject')?.value).toBe('This is a very long subject line')
	})

	it('handles empty body', () => {
		const headersOnly = 'From: a@b.com\nSubject: Test'
		const part = parseMimePart(headersOnly)
		expect(part.body).toBe('')
	})
})

// === decodeMimeWords

describe('decodeMimeWords', () => {
	it('decodes base64 encoded word', () => {
		expect(decodeMimeWords('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello')
	})

	it('decodes quoted-printable encoded word', () => {
		expect(decodeMimeWords('=?UTF-8?Q?Hello_World?=')).toBe('Hello World')
	})

	it('returns plain text unchanged', () => {
		expect(decodeMimeWords('Plain subject')).toBe('Plain subject')
	})

	it('decodes encoded word embedded in longer string', () => {
		const result = decodeMimeWords('Re: =?UTF-8?B?SGVsbG8=?= there')
		expect(result).toBe('Re: Hello there')
	})

	it('handles lowercase encoding marker', () => {
		expect(decodeMimeWords('=?utf-8?b?SGVsbG8=?=')).toBe('Hello')
	})

	it('falls back on invalid charset', () => {
		// Invalid charset should return the encoded text as-is
		const result = decodeMimeWords('=?INVALID-999?B?SGVsbG8=?=')
		expect(result).toBe('SGVsbG8=')
	})
})

// === extractMessage

describe('extractMessage', () => {
	it('extracts from, to, subject, date from plain .eml', () => {
		const part = parseMimePart(PLAIN_EML)
		const message = extractMessage(part)
		expect(message.from).toBe('Alice <alice@example.com>')
		expect(message.to).toEqual(['Bob <bob@example.com>'])
		expect(message.subject).toBe('Hello')
		expect(message.date).toBeInstanceOf(Date)
	})

	it('extracts plain text body', () => {
		const part = parseMimePart(PLAIN_EML)
		const message = extractMessage(part)
		expect(message.text).toContain('Hello, world!')
	})

	it('extracts text and html from multipart/alternative', () => {
		const part = parseMimePart(ALTERNATIVE_EML)
		const message = extractMessage(part)
		expect(message.text).toContain('Plain text version')
		expect(message.html).toContain('<p>HTML version</p>')
	})

	it('extracts attachment from multipart/mixed', () => {
		const part = parseMimePart(MULTIPART_EML)
		const message = extractMessage(part)
		expect(message.attachments).toHaveLength(1)
		expect(message.attachments[0]?.name).toBe('report.pdf')
		expect(message.attachments[0]?.mimeType).toBe('application/pdf')
	})

	it('returns empty to and cc arrays when headers are absent', () => {
		const minimal = 'From: a@b.com\n\nBody'
		const part = parseMimePart(minimal)
		const message = extractMessage(part)
		expect(message.to).toEqual([])
		expect(message.cc).toEqual([])
	})

	it('returns undefined date for malformed date header', () => {
		const bad = 'Date: not-a-date\n\nBody'
		const part = parseMimePart(bad)
		const message = extractMessage(part)
		expect(message.date).toBeUndefined()
	})

	it('handles multiple CC recipients', () => {
		const eml = [
			'From: a@b.com',
			'To: x@y.com, z@y.com',
			'Cc: c1@y.com, c2@y.com',
			'',
			'Body',
		].join('\n')
		const part = parseMimePart(eml)
		const message = extractMessage(part)
		expect(message.to).toHaveLength(2)
		expect(message.cc).toHaveLength(2)
	})
})

// === extractMessageFromMsg

describe('extractMessageFromMsg', () => {
	it('extracts subject from test.msg', () => {
		const buffer = loadMsgBuffer('test.msg')
		const reader = createMsgReader(buffer)
		const message = extractMessageFromMsg(reader)
		expect(message.subject.length).toBeGreaterThan(0)
	})

	it('extracts sender from test.msg', () => {
		const buffer = loadMsgBuffer('test.msg')
		const reader = createMsgReader(buffer)
		const message = extractMessageFromMsg(reader)
		expect(message.from.length).toBeGreaterThan(0)
	})

	it('returns string text body', () => {
		const buffer = loadMsgBuffer('test.msg')
		const reader = createMsgReader(buffer)
		const message = extractMessageFromMsg(reader)
		expect(typeof message.text).toBe('string')
	})

	it('extracts attachments from attachmentFiles.msg', () => {
		const buffer = loadMsgBuffer('attachmentFiles.msg')
		const reader = createMsgReader(buffer)
		const message = extractMessageFromMsg(reader)
		expect(message.attachments.length).toBeGreaterThan(0)
		for (const attachment of message.attachments) {
			expect(attachment.name.length).toBeGreaterThan(0)
			expect(attachment.size).toBeGreaterThan(0)
			expect(attachment.bytes).toBeInstanceOf(Uint8Array)
		}
	})

	it('throws on invalid binary', () => {
		const garbage = new ArrayBuffer(16)
		const reader = createMsgReader(garbage)
		expect(() => extractMessageFromMsg(reader)).toThrow('Unsupported file type')
	})
})

// === EmailParser (integration)

describe('EmailParser', () => {
	const parser = createEmailParser()

	it('exposes options', () => {
		expect(parser.options).toBeDefined()
	})

	it('accepts custom charset option', () => {
		const custom = createEmailParser({ charset: 'iso-8859-1' })
		expect(custom.options.charset).toBe('iso-8859-1')
	})

	it('parses a plain .eml file', async () => {
		const file = makeFile('test.eml', PLAIN_EML)
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.format).toBe('eml')
		expect(result.value.messages).toHaveLength(1)
		expect(result.value.messages[0]?.subject).toBe('Hello')
	})

	it('parses a multipart .eml with attachment', async () => {
		const file = makeFile('multi.eml', MULTIPART_EML)
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
		if (!result.success) return
		const message = result.value.messages[0]
		expect(message?.attachments).toHaveLength(1)
		expect(message?.attachments[0]?.name).toBe('report.pdf')
	})

	it('returns UnsupportedFormatError for unknown extension', async () => {
		const file = makeFile('email.xyz', 'content')
		const result = await parser.parse(file)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(isUnsupportedFormatError(result.error)).toBe(true)
		expect(isEmailParserError(result.error)).toBe(true)
	})

	it('detects .eml by message/rfc822 MIME type', async () => {
		const file = makeFile('noextension', PLAIN_EML, 'message/rfc822')
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
	})

	it('returns ParseError for .msg containing invalid binary', async () => {
		const file = makeFile('email.msg', 'not-an-ole-file')
		const result = await parser.parse(file)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(isParseError(result.error)).toBe(true)
		expect(isUnsupportedFormatError(result.error)).toBe(false)
	})

	it('returns ParseError for .msg detected by MIME type with invalid binary', async () => {
		const file = makeFile('noextension', 'garbage', 'application/vnd.ms-outlook')
		const result = await parser.parse(file)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(isParseError(result.error)).toBe(true)
	})

	it('parses a real .msg file', async () => {
		const buffer = readFileSync(join(fixturesDir, 'test.msg'))
		const file = makeBinaryFile('test.msg', buffer)
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.format).toBe('msg')
		expect(result.value.messages).toHaveLength(1)
		expect(result.value.messages[0]?.subject.length).toBeGreaterThan(0)
	})

	it('parses .msg with attachments', async () => {
		const buffer = readFileSync(join(fixturesDir, 'attachmentFiles.msg'))
		const file = makeBinaryFile('attachmentFiles.msg', buffer)
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.messages[0]?.attachments.length).toBeGreaterThan(0)
	})

	it('parses alternative .eml returning both text and html', async () => {
		const file = makeFile('alt.eml', ALTERNATIVE_EML)
		const result = await parser.parse(file)
		expect(result.success).toBe(true)
		if (!result.success) return
		const message = result.value.messages[0]
		expect(message?.text).toContain('Plain text version')
		expect(message?.html).toContain('<p>HTML version</p>')
	})
})
