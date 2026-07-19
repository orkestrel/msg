import type {
	EmailFormat,
	MIMEPart,
	EmailAttachment,
	EmailMessage,
	MSGAttachment,
	MSGFieldData,
} from './types.js'
import { MSGError } from './errors.js'
import { MIME_MAX_DEPTH, UTF8_SEQUENCE_MINIMUM } from './constants.js'
import {
	parseMIMEHeaders,
	decodeMIMEWords,
	decodeMIMEText,
	decodeMIMEEncoding,
	formatEmailAddress,
} from './helpers.js'

// === MSG Helpers

/**
 * Validate that a DataView starts with the CFB magic header.
 *
 * @param view - DataView to check
 * @returns True when the first 8 bytes match the CFB signature
 */
export function isMSGFile(view: DataView): boolean {
	const header = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
	if (view.byteLength < header.length) return false
	for (let i = 0; i < header.length; i++) {
		if (view.getUint8(i) !== header[i]) return false
	}
	return true
}

/**
 * Decode UTF-8 bytes into a string, WHATWG-style: an invalid byte
 * sequence decodes as U+FFFD rather than throwing. Rejects overlong
 * encodings, surrogate code points (0xD800-0xDFFF), and code points
 * beyond 0x10FFFF — each invalid sequence yields exactly one U+FFFD
 * and decoding resumes at the next lead byte.
 *
 * @param bytes - UTF-8 byte array
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeUTF8(new Uint8Array([65])) // 'A'
 * decodeUTF8(new Uint8Array([0xff])) // '�'
 * ```
 */
export function decodeUTF8(bytes: Uint8Array): string {
	let result = ''
	let i = 0

	while (i < bytes.length) {
		const byte0 = bytes[i]

		if (byte0 < 0x80) {
			result += String.fromCharCode(byte0)
			i++
			continue
		}

		let length = 0
		let codePoint = 0
		if ((byte0 & 0xe0) === 0xc0) {
			length = 1
			codePoint = byte0 & 0x1f
		} else if ((byte0 & 0xf0) === 0xe0) {
			length = 2
			codePoint = byte0 & 0x0f
		} else if ((byte0 & 0xf8) === 0xf0) {
			length = 3
			codePoint = byte0 & 0x07
		} else {
			result += '�'
			i++
			continue
		}

		if (i + length >= bytes.length) {
			result += '�'
			i++
			continue
		}

		let valid = true
		let value = codePoint
		for (let j = 1; j <= length; j++) {
			const next = bytes[i + j]
			if ((next & 0xc0) !== 0x80) {
				valid = false
				break
			}
			value = (value << 6) | (next & 0x3f)
		}

		if (!valid) {
			result += '�'
			i++
			continue
		}

		const minimum = UTF8_SEQUENCE_MINIMUM[length]
		const isOverlong = minimum !== undefined && value < minimum
		const isSurrogate = value >= 0xd800 && value <= 0xdfff
		const isOutOfRange = value > 0x10ffff

		if (isOverlong || isSurrogate || isOutOfRange) {
			result += '�'
			i += length + 1
			continue
		}

		i += length + 1

		if (value >= 0x10000) {
			value -= 0x10000
			result += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff))
		} else {
			result += String.fromCharCode(value)
		}
	}

	return result
}

// === EmailParser Helpers

/**
 * Derive the EmailFormat from a file name and/or MIME type.
 * Returns undefined when the format cannot be determined.
 *
 * @param name - File name to inspect
 * @param mime - MIME type to inspect
 * @returns Detected format or undefined
 *
 * @example
 * ```ts
 * detectFormat('message.eml', undefined) // 'eml'
 * detectFormat(undefined, 'application/vnd.ms-outlook') // 'msg'
 * ```
 */
export function detectFormat(
	name: string | undefined,
	mime: string | undefined,
): EmailFormat | undefined {
	const lower = name?.toLowerCase()

	if (lower?.endsWith('.eml') === true) return 'eml'
	if (lower?.endsWith('.msg') === true) return 'msg'

	if (mime === 'message/rfc822') return 'eml'
	if (mime === 'application/vnd.ms-outlook') return 'msg'

	return undefined
}

/**
 * Parse a raw RFC 2822 / MIME text string into a MIMEPart tree.
 * Line endings are normalised to \n before processing. Recursion is
 * capped at {@link MIME_MAX_DEPTH} to guard against a hostile or
 * pathological multipart nesting cycle.
 *
 * @param raw - Raw MIME text
 * @param depth - Current recursion depth (internal; callers omit this)
 * @returns Parsed MIMEPart tree
 * @throws {@link MSGError} with code `CYCLE` when nesting exceeds {@link MIME_MAX_DEPTH}
 */
export function parseMIMEPart(raw: string, depth = 0): MIMEPart {
	if (depth > MIME_MAX_DEPTH) {
		throw new MSGError('CYCLE', 'MIME multipart nesting exceeds maximum depth', {
			depth,
			max: MIME_MAX_DEPTH,
		})
	}

	const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	const split = normalised.indexOf('\n\n')
	const headerText = split === -1 ? normalised : normalised.slice(0, split)
	const body = split === -1 ? '' : normalised.slice(split + 2)

	const headers = parseMIMEHeaders(headerText)
	const contentType = headers.get('content-type')
	const primaryType = (contentType?.value ?? '').split(';')[0].trim().toLowerCase()
	const boundary = contentType?.params.get('boundary') ?? ''

	const parts: MIMEPart[] = []
	if (primaryType.startsWith('multipart/') && boundary !== '') {
		const delimiter = '--' + boundary
		const lines = body.split('\n')
		let current: string[] = []
		let inside = false

		for (const line of lines) {
			const trimmed = line.trimEnd()
			if (trimmed === delimiter + '--') {
				if (inside && current.length > 0) parts.push(parseMIMEPart(current.join('\n'), depth + 1))
				inside = false
				break
			}
			if (trimmed === delimiter) {
				if (inside && current.length > 0) parts.push(parseMIMEPart(current.join('\n'), depth + 1))
				current = []
				inside = true
				continue
			}
			if (inside) current.push(line)
		}

		if (inside && current.length > 0) parts.push(parseMIMEPart(current.join('\n'), depth + 1))
	}

	return { headers, body, parts }
}

/**
 * Extract a single EmailMessage from a parsed MSG source.
 * Reads field data and attachments from the given source.
 *
 * Each attachment is read independently: a corrupt attachment throws
 * from `reader.attachment(i)` is caught and that attachment is skipped
 * so the rest of the message still parses. This containment keeps one
 * damaged attachment stream from failing the entire message extraction.
 *
 * @param reader - A parsed MSG source exposing field data and attachment access
 * @returns Structured EmailMessage
 */
export function extractMessageFromMSG(reader: {
	parse(): MSGFieldData
	attachment(index: number): MSGAttachment
}): EmailMessage {
	const data = reader.parse()

	const from = formatEmailAddress(data.senderName, data.senderSMTPAddress ?? data.senderEmail)

	const recipients = data.recipients ?? []
	const to = recipients
		.filter((r) => r.recipientRole === 'to')
		.map((r) => formatEmailAddress(r.name, r.smtpAddress ?? r.email))
		.filter((s) => s.length > 0)
	const cc = recipients
		.filter((r) => r.recipientRole === 'cc')
		.map((r) => formatEmailAddress(r.name, r.smtpAddress ?? r.email))
		.filter((s) => s.length > 0)

	const rawDate = data.messageDeliveryTime ?? data.clientSubmitTime
	let date: Date | undefined
	if (rawDate !== undefined) {
		const parsed = new Date(rawDate)
		date = isNaN(parsed.getTime()) ? undefined : parsed
	}

	const attachments: EmailAttachment[] = []
	const attachmentFields = data.attachments ?? []
	for (let i = 0; i < attachmentFields.length; i++) {
		const attachment = attachmentFields[i]
		if (attachment === undefined) continue
		if (attachment.attachmentHidden === true) continue
		if (attachment.innerMSGContent === true) continue
		try {
			const extracted = reader.attachment(i)
			attachments.push({
				name: extracted.fileName,
				mimeType: attachment.mimeType ?? 'application/octet-stream',
				size: extracted.content.length,
				bytes: extracted.content,
			})
		} catch {
			// A single corrupt attachment stream must not fail the whole message.
			continue
		}
	}

	return {
		from,
		to,
		cc,
		subject: data.subject ?? '',
		date,
		text: data.body ?? '',
		html: data.bodyHTML ?? '',
		attachments,
	}
}

/**
 * Extract a single EmailMessage from a top-level MIMEPart.
 * Walks the full MIME tree to collect text, HTML, and attachments.
 *
 * @param part - Root MIMEPart from parseMIMEPart
 * @returns Structured EmailMessage
 */
export function extractMessage(part: MIMEPart): EmailMessage {
	const headerValue = (name: string): string => decodeMIMEWords(part.headers.get(name)?.value ?? '')

	const splitAddresses = (raw: string): readonly string[] =>
		raw.length === 0
			? []
			: raw
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s.length > 0)

	const rawDate = part.headers.get('date')?.value
	let date: Date | undefined
	if (rawDate !== undefined) {
		const parsed = new Date(rawDate)
		date = isNaN(parsed.getTime()) ? undefined : parsed
	}

	const collectedText: string[] = []
	const collectedHTML: string[] = []
	const attachments: EmailAttachment[] = []

	const walk = (p: MIMEPart) => {
		const contentType = p.headers.get('content-type')
		const disposition = p.headers.get('content-disposition')
		const transferEncoding = p.headers.get('content-transfer-encoding')

		const primaryType = (contentType?.value ?? 'text/plain').split(';')[0].trim().toLowerCase()
		const encoding = (transferEncoding?.value ?? '7bit').trim()
		const charset = contentType?.params.get('charset') ?? 'utf-8'
		const dispositionKind = (disposition?.value ?? '').trim().toLowerCase()

		if (primaryType.startsWith('multipart/')) {
			for (const child of p.parts) walk(child)
			return
		}

		const isAttachmentPart = dispositionKind === 'attachment'

		if (isAttachmentPart) {
			const name =
				disposition?.params.get('filename') ?? contentType?.params.get('name') ?? 'attachment'
			const bytes = decodeMIMEEncoding(p.body, encoding)
			attachments.push({
				name: decodeMIMEWords(name),
				mimeType: primaryType,
				size: bytes.length,
				bytes,
			})
			return
		}

		if (primaryType === 'text/plain') {
			collectedText.push(decodeMIMEText(p.body, encoding, charset))
			return
		}

		if (primaryType === 'text/html') {
			collectedHTML.push(decodeMIMEText(p.body, encoding, charset))
			return
		}

		// Inline binary parts with a filename become attachments
		const inlineName = contentType?.params.get('name') ?? disposition?.params.get('filename')
		if (inlineName !== undefined) {
			const bytes = decodeMIMEEncoding(p.body, encoding)
			attachments.push({
				name: decodeMIMEWords(inlineName),
				mimeType: primaryType,
				size: bytes.length,
				bytes,
			})
		}
	}

	walk(part)

	return {
		from: headerValue('from'),
		to: splitAddresses(headerValue('to')),
		cc: splitAddresses(headerValue('cc')),
		subject: headerValue('subject'),
		date,
		text: collectedText.join(''),
		html: collectedHTML.join(''),
		attachments,
	}
}
