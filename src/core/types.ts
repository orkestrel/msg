// === Result Pattern

/**
 * Represents a successful operation result.
 */
export interface Success<T> {
	readonly success: true
	readonly value: T
}

/**
 * Represents a failed operation result.
 */
export interface Failure<E> {
	readonly success: false
	readonly error: E
}

/**
 * Represents a discriminated union for operations that can succeed or fail safely.
 */
export type Result<T, E = Error> = Success<T> | Failure<E>

// === Encoding

/**
 * Names a supported text encoding for decoding non-Unicode MSG strings and
 * MIME part bodies.
 */
export type MSGEncoding = 'utf-8' | 'utf-16le' | 'windows-1252' | 'latin1'

// === MSGError

/**
 * Names a machine-readable classification for an {@link MSGError}.
 *
 * @remarks
 * - `UNSUPPORTED` — the input is not a recognized MSG/EML format
 * - `MALFORMED` — the input claims a recognized format but is structurally invalid
 * - `CYCLE` — a directory or MIME structure references itself, forming a cycle
 * - `RANGE` — a computed offset, length, or index falls outside the valid bounds
 * - `BURN` — the CFB binary writer could not reconstitute the entry list
 */
export type MSGErrorCode = 'UNSUPPORTED' | 'MALFORMED' | 'CYCLE' | 'RANGE' | 'BURN'

// === MSGReader

/**
 * Names a MAPI property data type tag.
 */
export type MSGFieldType = 'string' | 'unicode' | 'binary' | 'time' | 'integer' | 'boolean'

/**
 * Names a recipient role in a message.
 */
export type MSGRecipientRole = 'to' | 'cc' | 'bcc'

/**
 * Represents a CFB directory entry describing a storage or stream in the compound file.
 *
 * @remarks
 * - `category` — the entry's object-category byte, mirroring the Compound File
 *   Binary object type field at directory-entry offset `0x42`; compare it
 *   against `MSG_CATEGORY_ROOT`, `MSG_CATEGORY_DIRECTORY`,
 *   `MSG_CATEGORY_DOCUMENT`, and `MSG_CATEGORY_UNALLOCATED`
 */
export interface MSGDirectoryEntry {
	readonly category: number
	readonly name: string
	readonly previousProperty: number
	readonly nextProperty: number
	readonly childProperty: number
	readonly startBlock: number
	readonly sizeBlock: number
	readonly children?: readonly number[]
}

/**
 * Represents an internal accumulator for MSG field extraction whose members are all readonly.
 * The extraction path writes each resolved field through `Object.assign`, then narrows the
 * accumulator to {@link MSGFieldData} at the public boundary.
 */
export interface MSGMutableFieldData {
	readonly category: 'msg' | 'attachment' | 'recipient'
	readonly attachments?: readonly MSGMutableFieldData[]
	readonly recipients?: readonly MSGMutableFieldData[]
	readonly innerMSGContent?: true
	readonly innerMSGContentFields?: MSGMutableFieldData
	readonly dataId?: number
	readonly contentLength?: number
	readonly folderId?: number
	readonly [key: string]: unknown
}

/**
 * Represents a resolved named property entry from the __nameid_version1.0 storage.
 */
export interface MSGNameIdEntry {
	readonly useName: boolean
	readonly name?: string
	readonly propertySet?: string
	readonly propertyLid?: number
}

/**
 * Describes a CFB entry for the MSG burner (CFB binary writer).
 * Entries form a flat list starting with the root storage at index 0.
 *
 * @remarks
 * - `category` — the entry's object-category byte, written to the Compound File
 *   Binary object type field at directory-entry offset `0x42`; supply
 *   `MSG_CATEGORY_ROOT`, `MSG_CATEGORY_DIRECTORY`, or `MSG_CATEGORY_DOCUMENT`
 */
export interface MSGBurnerEntry {
	readonly name: string
	readonly category: number
	readonly length: number
	readonly binaryProvider?: () => Uint8Array
	readonly children?: readonly number[]
}

/**
 * Represents an internal lite entry with tree metadata used during CFB burn.
 * Tracks red-black coloring and sector allocation alongside
 * the source MSGBurnerEntry.
 */
export interface MSGBurnerLiteEntry {
	readonly entry: MSGBurnerEntry
	readonly left: number
	readonly right: number
	readonly child: number
	readonly firstSector: number
	readonly mini: boolean
	readonly red: boolean
}

/**
 * Holds parsed field data extracted from an MSG file.
 * Represents the root message, an attachment, or a recipient.
 *
 * @remarks
 * - `category` — discriminator: 'msg', 'attachment', or 'recipient'
 * - `subject` — message subject
 * - `senderName` — display name of the sender
 * - `senderEmail` — email address of the sender
 * - `body` — plain text body
 * - `headers` — transport message headers
 * - `bodyHTML` — HTML body (string)
 * - `html` — HTML body (binary)
 * - `compressedRTF` — compressed RTF body (binary)
 * - `attachments` — child attachment field data
 * - `recipients` — child recipient field data
 * - `innerMSGContent` — true if the attachment is an embedded .msg
 * - `innerMSGContentFields` — parsed fields of the embedded .msg
 * - `dataId` — internal CFBF entry index (for attachment binary access)
 * - `contentLength` — attachment binary length
 * - `folderId` — internal CFBF storage index (for embedded msg)
 * - `recipientRole` — recipient type: 'to', 'cc', or 'bcc'
 */
export interface MSGFieldData {
	readonly category: 'msg' | 'attachment' | 'recipient'
	// email properties
	readonly subject?: string
	readonly senderName?: string
	readonly senderEmail?: string
	readonly senderAddressType?: string
	readonly senderSMTPAddress?: string
	readonly sentRepresentingSMTPAddress?: string
	readonly body?: string
	readonly headers?: string
	readonly bodyHTML?: string
	readonly html?: Uint8Array
	readonly compressedRTF?: Uint8Array
	readonly messageClass?: string
	readonly messageFlags?: number
	readonly messageId?: string
	readonly internetCodepage?: number
	readonly messageCodepage?: number
	readonly messageLocaleId?: number
	readonly clientSubmitTime?: string
	readonly messageDeliveryTime?: string
	readonly creationTime?: string
	readonly lastModificationTime?: string
	readonly lastModifierName?: string
	readonly creatorSMTPAddress?: string
	readonly lastModifierSMTPAddress?: string
	readonly preview?: string
	readonly conversationTopic?: string
	readonly normalizedSubject?: string
	// recipient properties
	readonly name?: string
	readonly email?: string
	readonly addressType?: string
	readonly smtpAddress?: string
	readonly recipientRole?: MSGRecipientRole
	// attachment properties
	readonly extension?: string
	readonly fileNameShort?: string
	readonly fileName?: string
	readonly contentId?: string
	readonly attachmentHidden?: boolean
	readonly mimeType?: string
	readonly contentLength?: number
	readonly dataId?: number
	readonly folderId?: number
	readonly innerMSGContent?: true
	readonly innerMSGContentFields?: MSGFieldData
	readonly attachments?: readonly MSGFieldData[]
	readonly recipients?: readonly MSGFieldData[]
	// contact properties
	readonly departmentName?: string
	readonly middleName?: string
	readonly generation?: string
	readonly surname?: string
	readonly givenName?: string
	readonly companyName?: string
	readonly jobTitle?: string
	readonly location?: string
	readonly postalAddress?: string
	readonly streetAddress?: string
	readonly postalCode?: string
	readonly country?: string
	readonly stateOrProvince?: string
	readonly homePhone?: string
	readonly mobilePhone?: string
	readonly businessPhone?: string
	readonly businessFax?: string
	readonly businessHomePage?: string
	readonly namePrefix?: string
	readonly homeAddressCity?: string
	// appointment / calendar properties
	readonly appointmentStart?: string
	readonly appointmentEnd?: string
	readonly clipStart?: string
	readonly clipEnd?: string
	readonly timeZoneDescription?: string
	readonly appointmentLocation?: string
	readonly appointmentOldLocation?: string
	readonly globalAppointmentId?: string
	// PidLid — common
	readonly votingResponse?: string
	readonly internetAccountName?: string
	// PidLid — address
	readonly yomiFirstName?: string
	readonly yomiLastName?: string
	readonly yomiCompanyName?: string
	readonly primaryEmailAddress?: string
	readonly primaryEmailDisplayName?: string
	readonly primaryEmailOriginalDisplayName?: string
	readonly fileUnder?: string
	readonly workAddressCity?: string
	readonly workAddressStreet?: string
	readonly workAddressState?: string
	readonly workAddressPostalCode?: string
	readonly workAddressCountry?: string
	readonly workAddressCountryCode?: string
	readonly addressCountryCode?: string
	readonly contactWebPage?: string
	readonly workAddress?: string
	readonly instantMessagingAddress?: string
	readonly fax1AddressType?: string
	readonly fax1EmailAddress?: string
	readonly fax1OriginalDisplayName?: string
	readonly fax2AddressType?: string
	readonly fax2EmailAddress?: string
	readonly fax2OriginalDisplayName?: string
	readonly fax3AddressType?: string
	readonly fax3EmailAddress?: string
	readonly fax3OriginalDisplayName?: string
}

/**
 * Holds extracted attachment content from an MSG file.
 *
 * @remarks
 * - `name` — the attachment file name
 * - `bytes` — the raw binary content
 */
export interface MSGAttachment {
	readonly name: string
	readonly bytes: Uint8Array
}

/**
 * Represents a parsed MSG source an email shaper reads from: the field tree plus
 * indexed attachment access.
 *
 * @remarks
 * `MSG`'s constructor builds a separate adapter object that satisfies this
 * contract and hands it to `extractMessageFromMSG`, which accepts any other
 * value supplying the same call signatures. The `MSG` class itself does not
 * implement this interface.
 */
export interface MSGSourceInterface {
	/**
	 * Reads the parsed MAPI field tree.
	 *
	 * @returns The root message's field data
	 */
	parse(): MSGFieldData

	/**
	 * Reads attachment binary content by index.
	 *
	 * @param index - Zero-based index into the parsed attachment list
	 * @returns File name and raw binary content
	 */
	attachment(index: number): MSGAttachment
}

// === EmailParser

/**
 * Names a supported email file format.
 */
export type EmailFormat = 'eml' | 'msg'

/**
 * Represents a parsed MIME header with value and parameter map.
 *
 * @remarks
 * - `value` — primary header value (before first semicolon)
 * - `params` — key-value parameter map, for example `charset` and `boundary`
 */
export interface MIMEHeader {
	readonly value: string
	readonly params: ReadonlyMap<string, string>
}

/**
 * Represents a recursive MIME part tree node.
 *
 * @remarks
 * - `headers` — parsed header map keyed by lowercase name
 * - `body` — raw body text (empty for multipart containers)
 * - `parts` — child parts for multipart types
 */
export interface MIMEPart {
	readonly headers: ReadonlyMap<string, MIMEHeader>
	readonly body: string
	readonly parts: readonly MIMEPart[]
}

/**
 * Represents an attachment extracted from an email message.
 *
 * @remarks
 * - `name` — attachment file name
 * - `mimeType` — MIME content type
 * - `bytes` — raw binary content, whose `length` is the attachment's byte size
 */
export interface EmailAttachment {
	readonly name: string
	readonly mimeType: string
	readonly bytes: Uint8Array
}

/**
 * Represents a structured email message extracted from a parsed file.
 *
 * @remarks
 * - `from` — sender address string
 * - `to` — recipient addresses
 * - `cc` — carbon copy addresses
 * - `subject` — decoded subject line
 * - `date` — delivery date or undefined when absent/malformed
 * - `text` — plain-text body (includes quoted reply chain)
 * - `html` — HTML body (includes quoted reply chain)
 * - `attachments` — decoded file attachments
 */
export interface EmailMessage {
	readonly from: string
	readonly to: readonly string[]
	readonly cc: readonly string[]
	readonly subject: string
	readonly date: Date | undefined
	readonly text: string
	readonly html: string
	readonly attachments: readonly EmailAttachment[]
}

/**
 * Represents a parsed email chain from a single file.
 *
 * @remarks
 * - `format` — detected file format ('eml' or 'msg')
 * - `messages` — extracted messages (always length 1 for single-file formats)
 */
export interface EmailChain {
	readonly format: EmailFormat
	readonly messages: readonly EmailMessage[]
}

/**
 * Represents raw email input handed to an EmailParser.
 *
 * @remarks
 * - `bytes` — raw file content
 * - `name` — optional file name, used to infer format when `mime` is absent
 * - `mime` — optional MIME type, used to infer format
 */
export interface EmailInput {
	readonly bytes: Uint8Array
	readonly name?: string
	readonly mime?: string
}

// === MSG

/**
 * Represents raw input accepted by {@link createMSG}: binary MSG bytes or an
 * {@link EmailInput} for EML/MSG email parsing.
 */
export type MSGInput = Uint8Array | ArrayBuffer | EmailInput

/**
 * Configures the creation of an {@link MSGInterface}.
 *
 * @remarks
 * - `encoding` — decodes a non-Unicode MSG property string. Default:
 *   `'windows-1252'`. A MIME part body is decoded with the charset its own
 *   `content-type` header names, which this option does not reach.
 */
export interface MSGOptions {
	readonly encoding?: MSGEncoding
}

/**
 * Exposes the public surface of a parsed MSG/EML file.
 *
 * @remarks
 * - `options` — configuration used to parse this instance
 * - `chain` — the parsed email chain (format available through `chain.format`)
 * - `fields` — MSG field data, or `undefined` when the parsed format is `'eml'`
 * - `attachment` — read attachment binary content by index
 * - `burn` — rebuild the parsed MSG as a standalone CFB/.msg binary
 */
export interface MSGInterface {
	readonly options: MSGOptions
	readonly chain: EmailChain
	readonly fields: MSGFieldData | undefined

	/**
	 * Reads attachment binary content by index.
	 *
	 * Requires `'msg'` input. For `'eml'` input the MAPI field tree this index
	 * addresses is absent, so every index throws; read an `.eml` file's
	 * attachments from `chain.messages[0].attachments` instead.
	 *
	 * @param index - Zero-based index into the parsed attachment list
	 * @returns File name and raw binary content
	 * @throws {@link MSGError} with code `RANGE` when the index is out of bounds,
	 * and for every index when the parsed format is `'eml'`
	 */
	attachment(index: number): MSGAttachment

	/**
	 * Rebuilds the parsed MSG as a standalone CFB/.msg binary.
	 *
	 * @returns Complete CFB byte stream
	 * @throws {@link MSGError} with code `BURN` when the parsed structure
	 * cannot be reconstituted
	 */
	burn(): Uint8Array
}
