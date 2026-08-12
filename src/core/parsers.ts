import type { MIMEPart } from './types.js'
import { MSGError } from './errors.js'
import { MIME_MAX_DEPTH } from './constants.js'
import { parseMIMEHeaders } from './helpers.js'

// === MIME Parsers

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
	const primaryType = ((contentType?.value ?? '').split(';')[0] ?? '').trim().toLowerCase()
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
