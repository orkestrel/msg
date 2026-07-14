/**
 * EmailParser
 *
 * Parses .eml (RFC 2822 / MIME) and .msg (Outlook binary) files
 * into structured EmailMessage objects. Zero dependencies — uses
 * a pure-ES MIME parser for .eml and the built-in MsgReader for .msg.
 */

import type {
	EmailParserInterface,
	EmailParserOptions,
	EmailInput,
	Result,
	EmailChain,
} from './types.js'
import {
	detectFormat,
	parseMimePart,
	extractMessage,
	extractMessageFromMsg,
	isMsgFile,
	decodeUtf8,
	success,
	failure,
} from './helpers.js'
import { MsgError, isMsgError } from './errors.js'
import { MsgReader } from './MsgReader.js'

// === EmailParser

/**
 * Parses raw .eml or .msg file bytes into a structured {@link EmailChain}.
 * Synchronous and dependency-free: format detection falls back to sniffing
 * the CFB magic header when neither `name` nor `mime` resolves it, and every
 * parse failure is contained into a `Result` rather than thrown.
 *
 * @example
 * ```ts
 * import { createEmailParser, isSuccess } from '@src/core'
 *
 * const parser = createEmailParser()
 * const result = parser.parse({ bytes, name: 'message.eml' })
 * if (isSuccess(result)) {
 * 	const { messages } = result.value
 * 	console.log(messages[0].text)
 * 	console.log(messages[0].attachments)
 * }
 * ```
 */
export class EmailParser implements EmailParserInterface {
	readonly #options: EmailParserOptions

	constructor(options: EmailParserOptions = {}) {
		this.#options = { ...options }
	}

	/**
	 * Parse raw email bytes into a structured chain.
	 *
	 * @param input - Raw bytes plus optional name/MIME hints
	 * @returns A {@link Success} wrapping the parsed {@link EmailChain}, or a
	 * {@link Failure} wrapping an {@link MsgError} (code `UNSUPPORTED` when
	 * the format cannot be determined, `MALFORMED` when parsing fails)
	 *
	 * @example
	 * ```ts
	 * const result = parser.parse({ bytes, name: 'message.msg' })
	 * ```
	 */
	parse(input: EmailInput): Result<EmailChain, MsgError> {
		try {
			const format =
				detectFormat(input.name, input.mime) ??
				(isMsgFile(new DataView(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength))
					? 'msg'
					: undefined)

			if (format === undefined) {
				return failure(
					new MsgError(
						'UNSUPPORTED',
						`"${input.name ?? 'input'}" — only .eml and .msg files are supported`,
						{
							name: input.name,
							mime: input.mime,
						},
					),
				)
			}

			if (format === 'msg') {
				const reader = new MsgReader(input.bytes, { encoding: this.#options.encoding })
				const message = extractMessageFromMsg(reader)
				return success({ format, messages: [message] })
			}

			const text = decodeUtf8(input.bytes)
			const root = parseMimePart(text)
			const message = extractMessage(root)
			return success({ format, messages: [message] })
		} catch (cause) {
			if (isMsgError(cause)) return failure(cause)
			if (cause instanceof Error) return failure(new MsgError('MALFORMED', cause.message))
			return failure(new MsgError('MALFORMED', 'Failed to parse email input'))
		}
	}

	/**
	 * Current parser configuration.
	 *
	 * @returns A copy of the configured {@link EmailParserOptions} — the
	 * internal reference is never leaked
	 */
	get options(): EmailParserOptions {
		return { ...this.#options }
	}
}
