import type { MSGFieldType } from './types.js'

// === MSGReader

/**
 * Holds the CFB magic header bytes (0xD0CF11E0A1B11AE1).
 */
export const MSG_FILE_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/**
 * Names the sentinel for unused blocks in the FAT.
 */
export const MSG_UNUSED_BLOCK = -1

/**
 * Names the sentinel for end-of-chain in the FAT.
 */
export const MSG_END_OF_CHAIN = -2

/**
 * Holds the small sector size (512 bytes).
 */
export const MSG_S_BIG_BLOCK_SIZE = 0x0200

/**
 * Holds the small sector size mark in the header (byte at offset 30).
 */
export const MSG_S_BIG_BLOCK_MARK = 9

/**
 * Holds the large sector size (4096 bytes).
 */
export const MSG_L_BIG_BLOCK_SIZE = 0x1000

/**
 * Holds the large sector size mark in the header (byte at offset 30).
 */
export const MSG_L_BIG_BLOCK_MARK = 12

/**
 * Holds the mini-stream sector size (64 bytes).
 */
export const MSG_SMALL_BLOCK_SIZE = 0x0040

/**
 * Sets the threshold below which data is stored in the mini-stream.
 */
export const MSG_BIG_BLOCK_MIN_DOC_SIZE = 0x1000

/**
 * Locates the property (directory) start sector in the header.
 */
export const MSG_HEADER_PROPERTY_START_OFFSET = 0x30

/**
 * Locates the BAT sector array start in the header.
 */
export const MSG_HEADER_BAT_START_OFFSET = 0x4c

/**
 * Locates the BAT sector count in the header.
 */
export const MSG_HEADER_BAT_COUNT_OFFSET = 0x2c

/**
 * Locates the SBAT start sector in the header.
 */
export const MSG_HEADER_SBAT_START_OFFSET = 0x3c

/**
 * Locates the SBAT sector count in the header.
 */
export const MSG_HEADER_SBAT_COUNT_OFFSET = 0x40

/**
 * Locates the XBAT (DIFAT) start sector in the header.
 */
export const MSG_HEADER_XBAT_START_OFFSET = 0x44

/**
 * Locates the XBAT (DIFAT) sector count in the header.
 */
export const MSG_HEADER_XBAT_COUNT_OFFSET = 0x48

/**
 * Names the no-child/sibling index sentinel.
 */
export const MSG_PROP_NO_INDEX = -1

/**
 * Caps the recursion depth accepted by the directory hierarchy builder
 * (`MSGReader#buildHierarchy`). Defense-in-depth against a pathological
 * or hostile directory tree — the sibling-chain and visited-set guards
 * already bound each level, this caps the recursion depth itself.
 */
export const MSG_MAX_HIERARCHY_DEPTH = 64

/**
 * Holds the directory entry size in bytes.
 */
export const MSG_PROPERTY_SIZE = 0x0080

/**
 * Locates the name byte length within a directory entry.
 */
export const MSG_PROP_NAME_SIZE_OFFSET = 0x40

/**
 * Locates the object-category byte within a directory entry, mirroring the
 * Compound File Binary object type field.
 */
export const MSG_PROP_CATEGORY_OFFSET = 0x42

/**
 * Locates the left sibling index within a directory entry.
 */
export const MSG_PROP_PREVIOUS_PROPERTY_OFFSET = 0x44

/**
 * Locates the right sibling index within a directory entry.
 */
export const MSG_PROP_NEXT_PROPERTY_OFFSET = 0x48

/**
 * Locates the child index within a directory entry.
 */
export const MSG_PROP_CHILD_PROPERTY_OFFSET = 0x4c

/**
 * Locates the start sector of stream data within a directory entry.
 */
export const MSG_PROP_START_BLOCK_OFFSET = 0x74

/**
 * Locates the stream byte length within a directory entry.
 */
export const MSG_PROP_SIZE_OFFSET = 0x78

/**
 * Names the unallocated directory entry category.
 */
export const MSG_CATEGORY_UNALLOCATED = 0

/**
 * Names the storage (folder) directory entry category.
 */
export const MSG_CATEGORY_DIRECTORY = 1

/**
 * Names the stream (document) directory entry category.
 */
export const MSG_CATEGORY_DOCUMENT = 2

/**
 * Names the root storage directory entry category.
 */
export const MSG_CATEGORY_ROOT = 5

/**
 * Holds the name prefix for attachment storage entries.
 */
export const MSG_PREFIX_ATTACHMENT = '__attach_version1.0'

/**
 * Holds the name prefix for recipient storage entries.
 */
export const MSG_PREFIX_RECIPIENT = '__recip_version1.0'

/**
 * Holds the name prefix for document (substg) stream entries.
 */
export const MSG_PREFIX_DOCUMENT = '__substg1.'

/**
 * Holds the name prefix for named property mapping storage.
 */
export const MSG_PREFIX_NAMEID = '__nameid_version1.0'

/**
 * Maps a MAPI property tag to a field name.
 */
export const MSG_FIELD_NAME_MAPPING: Readonly<Record<string, string>> = Object.freeze({
	// email specific
	'001a': 'messageClass',
	'0037': 'subject',
	'0039': 'clientSubmitTime',
	'0070': 'conversationTopic',
	'007d': 'headers',
	'0c15': 'recipientRole',
	'0c1a': 'senderName',
	'0c1e': 'senderAddressType',
	'0c1f': 'senderEmail',
	'0e06': 'messageDeliveryTime',
	'0e07': 'messageFlags',
	'0e1d': 'normalizedSubject',
	'1000': 'body',
	'1009': 'compressedRTF',
	'1035': 'messageId',
	// recipient specific
	'3001': 'name',
	'3002': 'addressType',
	'3003': 'email',
	// shared (msg + attachment)
	'3007': 'creationTime',
	'3008': 'lastModificationTime',
	// attachment specific
	'3703': 'extension',
	'3704': 'fileNameShort',
	'3707': 'fileName',
	'3712': 'contentId',
	'370e': 'mimeType',
	// recipient / msg
	'39fe': 'smtpAddress',
	// msg metadata
	'3fd9': 'preview',
	'3fde': 'internetCodepage',
	'3ff1': 'messageLocaleId',
	'3ffa': 'lastModifierName',
	'3ffd': 'messageCodepage',
	'5d01': 'senderSMTPAddress',
	'5d02': 'sentRepresentingSMTPAddress',
	'5d0a': 'creatorSMTPAddress',
	'5d0b': 'lastModifierSMTPAddress',
	'7ffe': 'attachmentHidden',
	// contact specific
	'3a05': 'generation',
	'3a06': 'givenName',
	'3a08': 'businessPhone',
	'3a09': 'homePhone',
	'3a0d': 'location',
	'3a11': 'surname',
	'3a15': 'postalAddress',
	'3a16': 'companyName',
	'3a17': 'jobTitle',
	'3a18': 'departmentName',
	'3a1c': 'mobilePhone',
	'3a24': 'businessFax',
	'3a26': 'country',
	'3a27': 'homeAddressCity',
	'3a28': 'stateOrProvince',
	'3a29': 'streetAddress',
	'3a2a': 'postalCode',
	'3a44': 'middleName',
	'3a45': 'namePrefix',
	'3a51': 'businessHomePage',
})

/**
 * Maps a full 8-char property tag to a field name (for compound tags).
 */
export const MSG_FIELD_FULL_NAME_MAPPING: Readonly<Record<string, string>> = Object.freeze({
	'1013001f': 'bodyHTML',
	'10130102': 'html',
})

/**
 * Maps a MAPI property type tag to a decode type.
 */
export const MSG_FIELD_TYPE_MAPPING: Readonly<Record<string, MSGFieldType>> = Object.freeze({
	'001e': 'string',
	'001f': 'unicode',
	'0040': 'time',
	'0102': 'binary',
	'0003': 'integer',
	'000b': 'boolean',
})

/**
 * Identifies the attachment data class.
 */
export const MSG_FIELD_CLASS_ATTACHMENT_DATA = '3701'

/**
 * Names the directory field type indicating an embedded MSG.
 */
export const MSG_FIELD_DIR_TYPE_INNER_MSG = '000d'

/**
 * Names the TO MAPI recipient type.
 */
export const MSG_MAPI_RECIPIENT_TO = 1

/**
 * Names the CC MAPI recipient type.
 */
export const MSG_MAPI_RECIPIENT_CC = 2

/**
 * Names the BCC MAPI recipient type.
 */
export const MSG_MAPI_RECIPIENT_BCC = 3

/**
 * Holds the PidLid property set GUID to LID-to-field-name mapping.
 * Maps well-known MAPI named property sets to their property
 * long IDs and corresponding field names on MSGFieldData.
 */
export const MSG_PIDLID_MAPPING: Readonly<Record<string, Readonly<Record<number, string>>>> =
	Object.freeze({
		// PSETID_Common
		'00062008-0000-0000-c000-000000000046': Object.freeze({
			0x00008524: 'votingResponse',
			0x00008580: 'internetAccountName',
		}),
		// PSETID_Appointment
		'00062002-0000-0000-c000-000000000046': Object.freeze({
			0x0000820d: 'appointmentStart',
			0x0000820e: 'appointmentEnd',
			0x00008208: 'appointmentLocation',
			0x00008234: 'timeZoneDescription',
			0x00008235: 'clipStart',
			0x00008236: 'clipEnd',
		}),
		// PSETID_Address
		'00062004-0000-0000-c000-000000000046': Object.freeze({
			0x00008005: 'fileUnder',
			0x00008010: 'departmentName',
			0x0000801b: 'workAddress',
			0x0000802b: 'contactWebPage',
			0x0000802c: 'yomiFirstName',
			0x0000802d: 'yomiLastName',
			0x0000802e: 'yomiCompanyName',
			0x00008045: 'workAddressStreet',
			0x00008046: 'workAddressCity',
			0x00008047: 'workAddressState',
			0x00008048: 'workAddressPostalCode',
			0x00008049: 'workAddressCountry',
			0x00008062: 'instantMessagingAddress',
			0x00008080: 'primaryEmailDisplayName',
			0x00008083: 'primaryEmailAddress',
			0x00008084: 'primaryEmailOriginalDisplayName',
			0x000080b2: 'fax1AddressType',
			0x000080b3: 'fax1EmailAddress',
			0x000080b4: 'fax1OriginalDisplayName',
			0x000080c2: 'fax2AddressType',
			0x000080c3: 'fax2EmailAddress',
			0x000080c4: 'fax2OriginalDisplayName',
			0x000080d2: 'fax3AddressType',
			0x000080d3: 'fax3EmailAddress',
			0x000080d4: 'fax3OriginalDisplayName',
			0x000080db: 'workAddressCountryCode',
			0x000080dd: 'addressCountryCode',
		}),
		// PSETID_Meeting
		'6ed8da90-450b-101b-98da-00aa003f1305': Object.freeze({
			0x00000003: 'globalAppointmentId',
			0x00000028: 'appointmentOldLocation',
		}),
	})

// === MSGBurner

/**
 * Holds the standard CFB sector size in bytes (512).
 */
export const MSG_BURNER_SECTOR_SIZE = 512

/**
 * Holds the CFB mini-stream sector size in bytes (64).
 */
export const MSG_BURNER_MINI_SECTOR_SIZE = 64

/**
 * Sets the threshold below which streams are stored in the mini-stream (4096).
 */
export const MSG_BURNER_MINI_STREAM_CUTOFF = 4096

/**
 * Holds the number of 32-bit integers per standard sector (128).
 */
export const MSG_BURNER_INTS_PER_SECTOR = MSG_BURNER_SECTOR_SIZE / 4

/**
 * Caps the DIFAT entries stored in the CFB header (109).
 */
export const MSG_BURNER_DIFAT_HEADER_SLOTS = 109

/**
 * Holds the CFB directory entry size in bytes (128).
 */
export const MSG_BURNER_DIR_ENTRY_SIZE = 128

/**
 * Marks a sector as holding FAT data (-3).
 */
export const MSG_BURNER_FAT_SECTOR_MARKER = -3

/**
 * Marks a sector as holding DIFAT data (-4).
 */
export const MSG_BURNER_DIFAT_SECTOR_MARKER = -4

/**
 * Caps the UTF-16 code units allowed in a CFB directory entry name (31).
 * The fixed 64-byte name field holds 32 UTF-16 units including the
 * NUL terminator, so the name itself is capped at 31 units.
 */
export const MSG_BURNER_NAME_MAX = 31

/**
 * Holds the root entry CLSID for MSG compound files.
 */
export const MSG_BURNER_ROOT_CLSID = new Uint8Array([
	0x0b, 0x0d, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
])

// === EmailParser

/**
 * Lists the file extensions recognized as RFC 2822 / MIME email files.
 */
export const EML_EXTENSIONS: readonly string[] = Object.freeze(['.eml'])

/**
 * Lists the file extensions recognized as Outlook binary email files.
 */
export const MSG_EXTENSIONS: readonly string[] = Object.freeze(['.msg'])

/**
 * Lists the MIME types recognized as RFC 2822 / MIME email files.
 */
export const EML_MIME_TYPES: readonly string[] = Object.freeze(['message/rfc822'])

/**
 * Lists the MIME types recognized as Outlook binary email files.
 */
export const MSG_MIME_TYPES: readonly string[] = Object.freeze(['application/vnd.ms-outlook'])

/**
 * Names the default charset for decoding MIME part bodies.
 */
export const FALLBACK_CHARSET = 'utf-8'

/**
 * Names the default file name for attachments without an explicit name.
 */
export const FALLBACK_ATTACHMENT_NAME = 'attachment'

/**
 * Maps common MIME types to file extensions.
 * Used for inferring the correct extension during file extraction.
 */
export const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
	['image/jpeg', '.jpg'],
	['image/jpg', '.jpg'],
	['image/png', '.png'],
	['image/gif', '.gif'],
	['image/webp', '.webp'],
	['application/pdf', '.pdf'],
	['text/plain', '.txt'],
	['text/csv', '.csv'],
	['text/html', '.html'],
	['application/json', '.json'],
	['application/zip', '.zip'],
	['application/vnd.ms-excel', '.xls'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
	['application/msword', '.doc'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
	['application/vnd.ms-powerpoint', '.ppt'],
	['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
	['message/rfc822', '.eml'],
	['application/vnd.ms-outlook', '.msg'],
])

/**
 * Caps the multipart nesting depth accepted by `parseMIMEPart`.
 * Guards against pathological or hostile MIME trees causing
 * unbounded recursion.
 */
export const MIME_MAX_DEPTH = 50

/**
 * Holds the minimum valid code point for each UTF-8 sequence length, keyed by the
 * number of continuation bytes (1, 2, or 3). Enforces the WHATWG
 * requirement that a sequence encode the shortest possible form — an
 * overlong encoding (a code point below its sequence's minimum) is
 * rejected rather than accepted by `decodeUTF8`.
 */
export const UTF8_SEQUENCE_MINIMUM: Readonly<Record<number, number>> = Object.freeze({
	1: 0x80,
	2: 0x800,
	3: 0x10000,
})

/**
 * Holds the Windows-1252 high-byte (0x80-0x9F) to Unicode code point lookup.
 * Index `n` maps byte `0x80 + n` to its Unicode code point; entries
 * that Windows-1252 leaves undefined map to the byte's own value
 * (C1 control code passthrough) per the WHATWG encoding standard.
 */
export const WINDOWS_1252_HIGH: readonly number[] = Object.freeze([
	0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
	0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
	0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
])
