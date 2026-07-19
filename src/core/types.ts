// === Result Pattern

/**
 * Successful operation result.
 */
export interface Success<T> {
	readonly success: true
	readonly value: T
}

/**
 * Failed operation result.
 */
export interface Failure<E> {
	readonly success: false
	readonly error: E
}

/**
 * Discriminated union for operations that can succeed or fail safely.
 */
export type Result<T, E = Error> = Success<T> | Failure<E>

// === Encoding

/**
 * Supported text encoding for decoding non-Unicode MSG strings and
 * MIME part bodies.
 */
export type MSGEncoding = 'utf-8' | 'utf-16le' | 'windows-1252' | 'latin1'

// === MSGError

/**
 * Machine-readable classification for an {@link MSGError}.
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
 * Lifecycle type of a directory entry in a CFB compound file.
 */
export type MSGDirectoryEntryType = 'root' | 'directory' | 'document' | 'unallocated'

/**
 * MAPI property data type tag.
 */
export type MSGFieldType = 'string' | 'unicode' | 'binary' | 'time' | 'integer' | 'boolean'

/**
 * Recipient role in a message.
 */
export type MSGRecipientRole = 'to' | 'cc' | 'bcc'

/**
 * CFB directory entry describing a storage or stream in the compound file.
 */
export interface MSGDirectoryEntry {
	readonly type: number
	readonly name: string
	readonly previousProperty: number
	readonly nextProperty: number
	readonly childProperty: number
	readonly startBlock: number
	readonly sizeBlock: number
	children?: number[]
}

/**
 * Internal mutable accumulator used during MSG field extraction.
 * Properties are assigned dynamically via index signature and
 * narrowed to the readonly {@link MSGFieldData} at the public boundary.
 */
export interface MSGMutableFieldData {
	kind: 'msg' | 'attachment' | 'recipient'
	attachments?: MSGMutableFieldData[]
	recipients?: MSGMutableFieldData[]
	innerMSGContent?: true
	innerMSGContentFields?: MSGMutableFieldData
	dataId?: number
	contentLength?: number
	folderId?: number
	[key: string]: unknown
}

/**
 * Resolved named property entry from the __nameid_version1.0 storage.
 */
export interface MSGNameIdEntry {
	readonly useName: boolean
	readonly name?: string
	readonly propertySet?: string
	readonly propertyLid?: number
}

/**
 * CFB entry descriptor for the MSG burner (CFB binary writer).
 * Entries form a flat list starting with the root storage at index 0.
 */
export interface MSGBurnerEntry {
	readonly name: string
	readonly type: number
	readonly length: number
	readonly binaryProvider?: () => Uint8Array
	children?: number[]
}

/**
 * Internal lite entry with tree metadata used during CFB burn.
 * Tracks red-black coloring and sector allocation alongside
 * the source MSGBurnerEntry.
 */
export interface MSGBurnerLiteEntry {
	readonly entry: MSGBurnerEntry
	left: number
	right: number
	child: number
	firstSector: number
	readonly mini: boolean
	red: boolean
}

/**
 * Parsed field data extracted from an MSG file.
 * Represents the root message, an attachment, or a recipient.
 *
 * @remarks
 * - `kind` — discriminator: 'msg', 'attachment', or 'recipient'
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
	readonly kind: 'msg' | 'attachment' | 'recipient'
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
 * Extracted attachment content from an MSG file.
 *
 * @remarks
 * - `fileName` — the attachment file name
 * - `content` — the raw binary content
 */
export interface MSGAttachment {
	readonly fileName: string
	readonly content: Uint8Array
}

// === EmailParser

/**
 * Supported email file format.
 */
export type EmailFormat = 'eml' | 'msg'

/**
 * Parsed MIME header with value and parameter map.
 *
 * @remarks
 * - `value` — primary header value (before first semicolon)
 * - `params` — key-value parameter map (e.g. charset, boundary)
 */
export interface MIMEHeader {
	readonly value: string
	readonly params: ReadonlyMap<string, string>
}

/**
 * Recursive MIME part tree node.
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
 * Extracted attachment from an email message.
 *
 * @remarks
 * - `name` — attachment file name
 * - `mimeType` — MIME content type
 * - `size` — byte length
 * - `bytes` — raw binary content
 */
export interface EmailAttachment {
	readonly name: string
	readonly mimeType: string
	readonly size: number
	readonly bytes: Uint8Array
}

/**
 * Structured email message extracted from a parsed file.
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
 * Parsed email chain from a single file.
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
 * Raw email input handed to an EmailParser.
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
 * Raw input accepted by {@link createMSG}: binary MSG bytes or an
 * {@link EmailInput} for EML/MSG email parsing.
 */
export type MSGInput = Uint8Array | ArrayBuffer | EmailInput

/**
 * Configuration for creating an {@link MSGInterface}.
 *
 * @remarks
 * - `encoding` — encoding for non-Unicode strings and MIME part bodies (default `'windows-1252'`)
 */
export interface MSGOptions {
	readonly encoding?: MSGEncoding
}

/**
 * Public interface for a parsed MSG/EML file.
 *
 * @remarks
 * - `options` — configuration used to parse this instance
 * - `chain` — the parsed email chain (format available via `chain.format`)
 * - `fields` — MSG field data, or `undefined` when the parsed format is `'eml'`
 * - `attachment` — read attachment binary content by index
 * - `burn` — rebuild the parsed MSG as a standalone CFB/.msg binary
 */
export interface MSGInterface {
	readonly options: MSGOptions
	readonly chain: EmailChain
	readonly fields: MSGFieldData | undefined

	/**
	 * Read attachment binary content by index.
	 *
	 * @param index - Zero-based index into the parsed attachment list
	 * @returns File name and raw binary content
	 * @throws {@link MSGError} with code `RANGE` when the index is out of bounds
	 */
	attachment(index: number): MSGAttachment

	/**
	 * Rebuild the parsed MSG as a standalone CFB/.msg binary.
	 *
	 * @returns Complete CFB byte stream
	 * @throws {@link MSGError} with code `BURN` when the parsed structure
	 * cannot be reconstituted
	 */
	burn(): Uint8Array
}
