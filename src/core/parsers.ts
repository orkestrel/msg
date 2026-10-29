import type { MIMEPart } from './types.js'
import { MSGError } from './errors.js'
import { MIME_MAX_DEPTH } from './constants.js'
import { parseMIMEHeaders } from './helpers.js'

// === MIME Parsers

/**
 * Parses raw RFC 2822 / MIME text into a {@link MIMEPart} tree, throwing past
 * {@link MIME_MAX_DEPTH} levels of nesting.
 *
 * @remarks
 * Line endings normalize to `\n` before processing, and the recursion cap guards against a
 * hostile or pathological multipart nesting cycle.
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

	const lines = body.split('\n')
	const delimiter = '--' + boundary
	const closing = lines.findIndex((line) => line.trimEnd() === delimiter + '--')
	const end = closing === -1 ? lines.length : closing
	const starts =
		primaryType.startsWith('multipart/') && boundary !== ''
			? lines.slice(0, end).flatMap((line, index) => (line.trimEnd() === delimiter ? [index] : []))
			: []
	const parts = starts.flatMap((start, index) => {
		const content = lines.slice(start + 1, starts[index + 1] ?? end)
		return content.length === 0 ? [] : [parseMIMEPart(content.join('\n'), depth + 1)]
	})

	return { headers, body, parts }
}
