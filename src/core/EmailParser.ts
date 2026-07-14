/**
 * EmailParser
 *
 * Parses .eml (RFC 2822 / MIME) and .msg (Outlook binary) files
 * into structured EmailMessage objects. Zero dependencies — uses
 * native APIs for .eml and the built-in MsgReader for .msg.
 */

import type { EmailParserInterface, EmailParserOptions, Result, EmailChain } from '../types.js'
import { detectFormat, parseMimePart, extractMessage, extractMessageFromMsg } from '../helpers.js'
import { UnsupportedFormatError, ParseError } from '../errors.js'
import { MsgReader } from '../readers/MsgReader.js'

// === EmailParser

export class EmailParser implements EmailParserInterface {
	#options: EmailParserOptions

	constructor(options: EmailParserOptions = {}) {
		this.#options = { ...options }
	}

	/**
	 * Parse a dropped .eml or .msg File into an EmailChain.
	 *
	 * @param file - The File object from a browser drop or file-input event
	 * @returns A Result containing the EmailChain, or an error if parsing fails
	 *
	 * @example
	 * ```ts
	 * const parser = createEmailParser()
	 * const result = await parser.parse(file)
	 * if (result.success) {
	 *     const { messages } = result.value
	 *     console.log(messages[0].text)
	 *     console.log(messages[0].attachments)
	 * }
	 * ```
	 */
	async parse(file: File): Promise<Result<EmailChain>> {
		const format = detectFormat(file)

		if (format === undefined) {
			return {
				success: false,
				error: new UnsupportedFormatError(
					`"${file.name}" — only .eml and .msg files are supported`,
				),
			}
		}

		if (format === 'msg') {
			try {
				const buffer = await file.arrayBuffer()
				const reader = new MsgReader(buffer)
				const message = extractMessageFromMsg(reader)
				return { success: true, value: { format, messages: [message] } }
			} catch (cause) {
				return {
					success: false,
					error: new ParseError(`Failed to parse "${file.name}"`, cause),
				}
			}
		}

		try {
			const text = await file.text()
			const root = parseMimePart(text)
			const message = extractMessage(root)
			return { success: true, value: { format, messages: [message] } }
		} catch (cause) {
			return {
				success: false,
				error: new ParseError(`Failed to parse "${file.name}"`, cause),
			}
		}
	}

	get options(): EmailParserOptions {
		return this.#options
	}
}
