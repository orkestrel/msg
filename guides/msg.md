# MSG

> A zero-dependency parser for Outlook `.msg` (CFB/OLE2 compound binary) and `.eml`
> (RFC 2822 / MIME) email files, projecting either format into one structured `EmailChain`.

A pure-ES encoding layer (Base64, UTF-8, Latin-1, Windows-1252, quoted-printable, RFC 2047
encoded words) and the CFB sector and directory machinery in `parsers.ts`, `helpers.ts`, and
`shapers.ts` back either format without a `TextDecoder` dependency, so the whole surface stays
usable in the core's DOM/Node-free environment. Source: [`src/core`](../src/core). Surfaced
through the `@src/core` barrel.

## Surface

One `MSG` class parses either format. Construction is eager: the constructor
either fully parses the input or throws a typed `MSGError`. A parsed instance
exposes the structured `chain` (`EmailChain`) for either format. For `.msg`
input it also exposes the raw MAPI field tree (`fields`) plus `attachment` and
`burn` access.

Parse a raw file's bytes without knowing its format ahead of time — `.eml` or
`.msg` — and narrow the `Result` before touching the parsed chain. `createMSG`
is the `Result`-returning dual of `new MSG()`: every parse failure surfaces as
a `Failure<MSGError>` rather than throwing, and an unexpected non-`MSGError`
error still propagates. Reach for `new MSG()` directly when a thrown
`MSGError` is the control flow you want:

```ts
import { createMSG, isSuccess } from '@orkestrel/msg'

const result = createMSG({ bytes, name: 'message.eml' })
if (isSuccess(result)) {
	const msg = result.value
	console.log(msg.chain.format)
	console.log(msg.chain.messages[0].text)
}
```

### Types

From [`types.ts`](../src/core/types.ts). A `Shape` cell holds a type alias's value, and an
interface's members in braces; it stays empty where an interface carries more members than a cell
can list. `MSGInterface`'s call-signature members are documented under [`## Methods`](#methods).

| Type                  | Kind      | Shape                                                                                                                                  | Summary                                                                                                                                                                                                                                    |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Success<T>`          | interface | `{ success: true, value }`                                                                                                             | Represents a successful `Result`, carrying the value the operation produced.                                                                                                                                                               |
| `Failure<E>`          | interface | `{ success: false, error }`                                                                                                            | Represents a failed `Result`, carrying the error the operation produced.                                                                                                                                                                   |
| `Result<T, E>`        | type      | `Success<T> \| Failure<E>`                                                                                                             | Represents a discriminated union for operations that can succeed or fail safely.                                                                                                                                                           |
| `MSGEncoding`         | type      | `'utf-8' \| 'utf-16le' \| 'windows-1252' \| 'latin1'`                                                                                  | Names a supported text encoding for decoding non-Unicode MSG strings and MIME part bodies.                                                                                                                                                 |
| `MSGErrorCode`        | type      | `'UNSUPPORTED' \| 'MALFORMED' \| 'CYCLE' \| 'RANGE' \| 'BURN'`                                                                         | Names a machine-readable classification for an `MSGError`.                                                                                                                                                                                 |
| `MSGFieldType`        | type      | `'string' \| 'unicode' \| 'binary' \| 'time' \| 'integer' \| 'boolean'`                                                                | Names a MAPI property data type tag.                                                                                                                                                                                                       |
| `MSGRecipientRole`    | type      | `'to' \| 'cc' \| 'bcc'`                                                                                                                | Names a recipient role in a message.                                                                                                                                                                                                       |
| `MSGDirectoryEntry`   | interface | `{ category, name, previousProperty, nextProperty, childProperty, startBlock, sizeBlock, children? }`                                  | Represents a CFB directory entry describing a storage or stream in the compound file.                                                                                                                                                      |
| `MSGMutableFieldData` | interface | `{ category, attachments?, recipients?, innerMSGContent?, innerMSGContentFields?, dataId?, contentLength?, folderId?, [key: string] }` | Represents an internal accumulator for MSG field extraction whose members are all readonly. The extraction path writes each resolved field through `Object.assign`, then narrows the accumulator to `MSGFieldData` at the public boundary. |
| `MSGNameIdEntry`      | interface | `{ useName, name?, propertySet?, propertyLid? }`                                                                                       | Represents a resolved named property entry from the `__nameid_version1.0` storage.                                                                                                                                                         |
| `MSGBurnerEntry`      | interface | `{ name, category, length, binaryProvider?, children? }`                                                                               | Describes one CFB entry for `burnCFB`, the compound-file binary writer. Entries form a flat list whose root storage sits at index 0, each entry's children reachable through its `children` indices.                                       |
| `MSGBurnerLiteEntry`  | interface | `{ entry, left, right, child, firstSector, mini, red }`                                                                                | Represents an internal lite entry with tree metadata used during CFB burn. Tracks red-black coloring and sector allocation alongside the source MSGBurnerEntry.                                                                            |
| `MSGFieldData`        | interface |                                                                                                                                        | Holds the field data parsed out of one MSG entity — the root message, an attachment, or a recipient — across its email, recipient, attachment, contact, and appointment fields.                                                            |
| `MSGAttachment`       | interface | `{ name, bytes }`                                                                                                                      | Holds extracted attachment content from an MSG file.                                                                                                                                                                                       |
| `MSGSourceInterface`  | interface | `{ parse, attachment }`                                                                                                                | Represents the parsed MSG source `extractMessageFromMSG` reads from: the field tree plus indexed attachment access.                                                                                                                        |
| `EmailFormat`         | type      | `'eml' \| 'msg'`                                                                                                                       | Names a supported email file format.                                                                                                                                                                                                       |
| `MIMEHeader`          | interface | `{ value, params }`                                                                                                                    | Represents a parsed MIME header: its primary value and its parameter map.                                                                                                                                                                  |
| `MIMEPart`            | interface | `{ headers, body, parts }`                                                                                                             | Represents a recursive MIME part tree node.                                                                                                                                                                                                |
| `EmailAttachment`     | interface | `{ name, mimeType, bytes }`                                                                                                            | Represents an attachment extracted from an email message.                                                                                                                                                                                  |
| `EmailMessage`        | interface | `{ from, to, cc, subject, date, text, html, attachments }`                                                                             | Represents a structured email message extracted from a parsed file.                                                                                                                                                                        |
| `EmailChain`          | interface | `{ format, messages }`                                                                                                                 | Represents a parsed email chain from a single file.                                                                                                                                                                                        |
| `EmailInput`          | interface | `{ bytes, name?, mime? }`                                                                                                              | Represents the raw email input handed to `createMSG` or `new MSG()`.                                                                                                                                                                       |
| `MSGInput`            | type      | `Uint8Array \| ArrayBuffer \| EmailInput`                                                                                              | Represents the raw input `createMSG` and `new MSG()` accept: binary MSG bytes, an `ArrayBuffer` over them, or an `EmailInput` carrying a file-name or MIME hint.                                                                           |
| `MSGOptions`          | interface | `{ encoding? }`                                                                                                                        | Configures the creation of an `MSGInterface`.                                                                                                                                                                                              |
| `MSGInterface`        | interface | `{ options, chain, fields, attachment, burn }`                                                                                         | Exposes the public surface of a parsed MSG/EML file.                                                                                                                                                                                       |

### Constants

The CFB layout offsets and sizes, the MSG/EML sniffing tables, the MAPI field name mappings, and the burner's geometry, from [`constants.ts`](../src/core/constants.ts). None of them carries runtime behavior. Every value is a fixed offset, a size, or a lookup table that the parsing and burning code in `MSG.ts`, `parsers.ts`, and `helpers.ts` reads.

| Constant                            | Kind  | Value                                                        | Summary                                                                                                                                     |
| ----------------------------------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `MSG_FILE_HEADER`                   | const | `readonly number[]`, frozen                                  | Holds the 8-byte CFB/OLE2 magic signature (`D0 CF 11 E0 A1 B1 1A E1`) a `.msg` file must open with.                                         |
| `MSG_UNUSED_BLOCK`                  | const | `-1`                                                         | Names the FAT and mini-FAT sentinel for an unallocated sector.                                                                              |
| `MSG_END_OF_CHAIN`                  | const | `-2`                                                         | Names the FAT and mini-FAT sentinel marking a sector chain's end.                                                                           |
| `MSG_SECTOR_SIZE`                   | const | `0x0200`                                                     | Holds the standard CFB sector size in bytes (512), read when the header's sector shift is `MSG_S_BIG_BLOCK_MARK` and written by every burn. |
| `MSG_S_BIG_BLOCK_MARK`              | const | `9`                                                          | Holds the header sector-shift value selecting `MSG_SECTOR_SIZE` (byte at offset 30).                                                        |
| `MSG_L_BIG_BLOCK_SIZE`              | const | `0x1000`                                                     | Holds the large CFB sector size in bytes (4096), read when the header's sector shift is `MSG_L_BIG_BLOCK_MARK`.                             |
| `MSG_L_BIG_BLOCK_MARK`              | const | `12`                                                         | Holds the header sector-shift value selecting `MSG_L_BIG_BLOCK_SIZE` (the byte at offset 30).                                               |
| `MSG_MINI_SECTOR_SIZE`              | const | `0x0040`                                                     | Holds the CFB mini-stream sector size in bytes (64), read by the parse path and written by every burn.                                      |
| `MSG_MINI_STREAM_CUTOFF`            | const | `0x1000`                                                     | Sets the stream size (4096) at and above which a stream leaves the mini-stream for standard sectors.                                        |
| `MSG_HEADER_PROPERTY_START_OFFSET`  | const | `0x30`                                                       | Locates the root directory sector's start within the CFB header.                                                                            |
| `MSG_HEADER_BAT_START_OFFSET`       | const | `0x4c`                                                       | Locates the DIFAT's first 109 FAT sector entries within the CFB header.                                                                     |
| `MSG_HEADER_BAT_COUNT_OFFSET`       | const | `0x2c`                                                       | Locates the total FAT sector count within the CFB header.                                                                                   |
| `MSG_HEADER_SBAT_START_OFFSET`      | const | `0x3c`                                                       | Locates the mini-FAT's first sector within the CFB header.                                                                                  |
| `MSG_HEADER_SBAT_COUNT_OFFSET`      | const | `0x40`                                                       | Locates the mini-FAT sector count within the CFB header.                                                                                    |
| `MSG_HEADER_XBAT_START_OFFSET`      | const | `0x44`                                                       | Locates the first DIFAT (XBAT) sector within the CFB header.                                                                                |
| `MSG_HEADER_XBAT_COUNT_OFFSET`      | const | `0x48`                                                       | Locates the DIFAT (XBAT) sector count within the CFB header.                                                                                |
| `MSG_PROP_NO_INDEX`                 | const | `-1`                                                         | Names the directory-entry sentinel standing for no such property in the previous, next, and child index fields.                             |
| `MSG_MAX_HIERARCHY_DEPTH`           | const | `64`                                                         | Caps the recursion depth of the directory-tree traversal, guarding against a cyclic or hostile property chain.                              |
| `MSG_DIRECTORY_ENTRY_SIZE`          | const | `0x0080`                                                     | Holds the fixed size in bytes (128) of one CFB directory entry, read by the parse path and written by every burn.                           |
| `MSG_PROP_NAME_SIZE_OFFSET`         | const | `0x40`                                                       | Locates the entry name's UTF-16 byte length within a directory entry.                                                                       |
| `MSG_PROP_CATEGORY_OFFSET`          | const | `0x42`                                                       | Locates the object-category byte within a directory entry, mirroring the Compound File Binary object type field.                            |
| `MSG_PROP_PREVIOUS_PROPERTY_OFFSET` | const | `0x44`                                                       | Locates the red-black tree's previous sibling index within a directory entry.                                                               |
| `MSG_PROP_NEXT_PROPERTY_OFFSET`     | const | `0x48`                                                       | Locates the red-black tree's next sibling index within a directory entry.                                                                   |
| `MSG_PROP_CHILD_PROPERTY_OFFSET`    | const | `0x4c`                                                       | Locates the first child storage index within a directory entry.                                                                             |
| `MSG_PROP_START_BLOCK_OFFSET`       | const | `0x74`                                                       | Locates the entry's starting sector of stream data within a directory entry.                                                                |
| `MSG_PROP_SIZE_OFFSET`              | const | `0x78`                                                       | Locates the stream byte length within a directory entry.                                                                                    |
| `MSG_CATEGORY_UNALLOCATED`          | const | `0`                                                          | Names the directory-entry category byte for an unallocated (free) slot.                                                                     |
| `MSG_CATEGORY_DIRECTORY`            | const | `1`                                                          | Names the directory-entry category byte for a storage (folder-like) entry.                                                                  |
| `MSG_CATEGORY_DOCUMENT`             | const | `2`                                                          | Names the directory-entry category byte for a stream (document) entry.                                                                      |
| `MSG_CATEGORY_ROOT`                 | const | `5`                                                          | Names the directory-entry category byte for the single root storage entry.                                                                  |
| `MSG_PREFIX_ATTACHMENT`             | const | `'__attach_version1.0'`                                      | Holds the storage name prefix for an attachment entry.                                                                                      |
| `MSG_PREFIX_RECIPIENT`              | const | `'__recip_version1.0'`                                       | Holds the storage name prefix for a recipient entry.                                                                                        |
| `MSG_PREFIX_DOCUMENT`               | const | `'__substg1.'`                                               | Holds the stream name prefix for a MAPI property document (substg) entry.                                                                   |
| `MSG_PREFIX_NAMEID`                 | const | `'__nameid_version1.0'`                                      | Holds the storage name of the named-property mapping table.                                                                                 |
| `MSG_FIELD_NAME_MAPPING`            | const | `Readonly<Record<string, string>>`                           | Maps a MAPI property tag's hex to its short field name, for example `subject`.                                                              |
| `MSG_FIELD_FULL_NAME_MAPPING`       | const | `Readonly<Record<string, string>>`                           | Maps a compound tag's full 8-character hex to its fully-qualified field name.                                                               |
| `MSG_FIELD_TYPE_MAPPING`            | const | `Readonly<Record<string, MSGFieldType>>`                     | Maps a MAPI property type tag's hex to its `MSGFieldType` decode tag.                                                                       |
| `MSG_FIELD_CLASS_ATTACHMENT_DATA`   | const | `'3701'`                                                     | Identifies the MAPI tag naming an attachment's binary data stream.                                                                          |
| `MSG_FIELD_DIR_TYPE_INNER_MSG`      | const | `'000d'`                                                     | Names the MAPI type tag identifying an embedded `.msg` attachment storage.                                                                  |
| `MSG_MAPI_RECIPIENT_TO`             | const | `1`                                                          | Names the MAPI recipient-type value mapping to `MSGRecipientRole` `'to'`.                                                                   |
| `MSG_MAPI_RECIPIENT_CC`             | const | `2`                                                          | Names the MAPI recipient-type value mapping to `MSGRecipientRole` `'cc'`.                                                                   |
| `MSG_MAPI_RECIPIENT_BCC`            | const | `3`                                                          | Names the MAPI recipient-type value mapping to `MSGRecipientRole` `'bcc'`.                                                                  |
| `MSG_PIDLID_MAPPING`                | const | `Readonly<Record<string, Readonly<Record<number, string>>>>` | Maps a named-property set GUID to its long-ID-to-field-name table.                                                                          |
| `MSG_BURNER_INTS_PER_SECTOR`        | const | `MSG_SECTOR_SIZE / 4`                                        | Holds the number of 32-bit FAT and DIFAT entries one standard sector carries (128).                                                         |
| `MSG_BURNER_DIFAT_HEADER_SLOTS`     | const | `109`                                                        | Caps the DIFAT entries stored directly in the CFB header (109).                                                                             |
| `MSG_BURNER_FAT_SECTOR_MARKER`      | const | `-3`                                                         | Marks a sector as itself part of the FAT (-3).                                                                                              |
| `MSG_BURNER_DIFAT_SECTOR_MARKER`    | const | `-4`                                                         | Marks a sector as part of the DIFAT (-4).                                                                                                   |
| `MSG_BURNER_NAME_MAX`               | const | `31`                                                         | Caps the UTF-16 code units a written CFB directory entry name may hold (31).                                                                |
| `MSG_BURNER_ROOT_CLSID`             | const | `readonly number[]`, frozen                                  | Holds the 16-byte CLSID `burnCFB` writes for a compound file's root storage entry.                                                          |
| `EML_EXTENSIONS`                    | const | `['.eml']`                                                   | Lists the file-name extensions sniffed as the `'eml'` `EmailFormat`, the RFC 2822 / MIME email files.                                       |
| `MSG_EXTENSIONS`                    | const | `['.msg']`                                                   | Lists the file-name extensions sniffed as the `'msg'` `EmailFormat`, the Outlook binary email files.                                        |
| `EML_MIME_TYPES`                    | const | `['message/rfc822']`                                         | Lists the MIME types sniffed as the `'eml'` `EmailFormat`, the RFC 2822 / MIME email files.                                                 |
| `MSG_MIME_TYPES`                    | const | `['application/vnd.ms-outlook']`                             | Lists the MIME types sniffed as the `'msg'` `EmailFormat`, the Outlook binary email files.                                                  |
| `FALLBACK_CHARSET`                  | const | `'utf-8'`                                                    | Names the charset `resolveEncoding` falls back to when a MIME part body's label is unrecognized.                                            |
| `FALLBACK_ATTACHMENT_NAME`          | const | `'attachment'`                                               | Names the file name `extractMessage` falls back to for an attachment part carrying no `filename` or `name` parameter.                       |
| `MIME_EXTENSIONS`                   | const | `ReadonlyMap<string, string>`                                | Maps a common MIME type to the file extension `inferExtension` gives it during file extraction.                                             |
| `MIME_MAX_DEPTH`                    | const | `50`                                                         | Caps the multipart nesting depth `parseMIMEPart` accepts (50).                                                                              |
| `UTF8_SEQUENCE_MINIMUM`             | const | `Readonly<Record<number, number>>`                           | Holds the minimum valid code point for each UTF-8 sequence length, keyed by the number of continuation bytes (1, 2, or 3).                  |
| `WINDOWS_1252_HIGH`                 | const | `readonly number[]`                                          | Holds the Windows-1252 code point table for the high bytes `0x80`\-`0x9F`.                                                                  |

### Errors

From [`errors.ts`](../src/core/errors.ts) — every MSG/EML parsing or burning failure `throw`s (or, for `createMSG`, returns) an `MSGError` carrying a machine-readable `code`.

| Symbol       | Kind     | Signature                               | Summary                                                                                                                                                           |
| ------------ | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MSGError`   | class    | `new MSGError(code, message, context?)` | Represents an error thrown or returned by the MSG/EML parsing and burning surfaces, carrying a machine-readable `MSGErrorCode` and optional structured `context`. |
| `isMSGError` | function | `(value: unknown) => value is MSGError` | Narrows an unknown caught (or `Failure.error`) value to an `MSGError`.                                                                                            |

```ts
import { isMSGError, MSGError } from '@orkestrel/msg'

try {
	throw new MSGError('MALFORMED', 'bad input', { offset: 8 })
} catch (error) {
	if (isMSGError(error) && error.code === 'MALFORMED') console.log(error.context)
}
```

### Helpers

Pure, mostly-total leaves from [`helpers.ts`](../src/core/helpers.ts) — the `Result` constructors/guards, the CFB byte/string/UUID readers and magic check `MSG.ts` composes, the format sniffer, and the MIME/text codecs `parsers.ts` and `shapers.ts` compose.

| Helper                | Kind     | Signature                                                           | Summary                                                                                                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`             | function | `<T>(value: T) => Success<T>`                                       | Constructs a `Success` wrapping a value.                                                                                                                                                       |
| `failure`             | function | `<E>(error: E) => Failure<E>`                                       | Constructs a `Failure` wrapping an error.                                                                                                                                                      |
| `isSuccess`           | function | `<T, E>(result: Result<T, E>) => result is Success<T>`              | Narrows a `Result` to a `Success`.                                                                                                                                                             |
| `isFailure`           | function | `<T, E>(result: Result<T, E>) => result is Failure<E>`              | Narrows a `Result` to a `Failure`.                                                                                                                                                             |
| `truncateAtNull`      | function | `(text: string) => string`                                          | Truncates a string at its first `\0` character.                                                                                                                                                |
| `readUTF16String`     | function | `(view: DataView, offset: number, charCount: number) => string`     | Reads a UTF-16LE string out of a `DataView`, throwing when the requested range exceeds the view's bounds.                                                                                      |
| `decodeText`          | function | `(bytes: Uint8Array, encoding?: MSGEncoding) => string`             | Decodes bytes into a string with a pure-ES decoder, dispatching on the named encoding. Default: `windows-1252`.                                                                                |
| `fileTimeToUTCString` | function | `(low: number, high: number) => string`                             | Converts a Windows FILETIME (100-ns ticks since 1601-01-01) to a UTC date string.                                                                                                              |
| `toHexLower`          | function | `(value: number, length: number) => string`                         | Converts a number to a zero-padded lowercase hex string of the requested digit count.                                                                                                          |
| `readMicrosoftUUID`   | function | `(bytes: Uint8Array, offset: number) => string`                     | Reads a mixed-endian Microsoft UUID starting at an offset in a byte array, throwing past the array's bounds.                                                                                   |
| `roundUpToMultiple`   | function | `(value: number, boundary: number) => number`                       | Rounds a value up to the nearest multiple of a boundary, which must be a power of 2.                                                                                                           |
| `computeSectors`      | function | `(bytes: number, sectorSize: number) => number`                     | Computes how many sectors of a given size hold a byte count, answering 0 for a count at or below zero.                                                                                         |
| `compareCFBName`      | function | `(a: string, b: string) => number`                                  | Orders two directory names as the compound file format requires, comparing by UTF-16 length first and then by uppercased code points.                                                          |
| `isMSGFile`           | function | `(view: DataView) => boolean`                                       | Reports whether a `DataView`'s first 8 bytes match the CFB magic signature.                                                                                                                    |
| `decodeBase64`        | function | `(text: string) => Uint8Array`                                      | Decodes a Base64 string into raw bytes without relying on `atob`, ignoring ASCII whitespace and tolerating missing padding.                                                                    |
| `encodeUTF8`          | function | `(text: string) => Uint8Array`                                      | Encodes a string into UTF-8 bytes, pairing surrogates and encoding a lone (unpaired) surrogate as U+FFFD.                                                                                      |
| `decodeUTF8`          | function | `(bytes: Uint8Array) => string`                                     | Decodes UTF-8 bytes into a string WHATWG-style: an invalid byte sequence decodes as U+FFFD rather than throwing.                                                                               |
| `decodeLatin1`        | function | `(bytes: Uint8Array) => string`                                     | Decodes Latin-1 (ISO-8859-1) bytes into a string, byte-for-code-point.                                                                                                                         |
| `decodeWindows1252`   | function | `(bytes: Uint8Array) => string`                                     | Decodes Windows-1252 bytes into a string, resolving the `0x80`\-`0x9F` range through `WINDOWS_1252_HIGH` and otherwise matching `decodeLatin1`.                                                |
| `resolveEncoding`     | function | `(label: string \| undefined) => MSGEncoding`                       | Resolves a free-form charset label, as a MIME `charset` parameter carries it, to a supported `MSGEncoding`, falling back to `FALLBACK_CHARSET`'s encoding for an unrecognized or absent label. |
| `detectFormat`        | function | `(name?: string, mime?: string) => EmailFormat \| undefined`        | Derives the `EmailFormat` from a file name, a MIME type, or both, answering `undefined` when neither hints at a format.                                                                        |
| `parseMIMEHeaders`    | function | `(text: string) => ReadonlyMap<string, MIMEHeader>`                 | Parses an RFC 2822 / MIME header block, folding continuation lines.                                                                                                                            |
| `decodeMIMEEncoding`  | function | `(body: string, encoding: string) => Uint8Array`                    | Decodes a MIME body — `base64`, `quoted-printable`, or passthrough — into raw bytes, throwing on invalid Base64.                                                                               |
| `decodeMIMEText`      | function | `(body: string, encoding: string, charset: string) => string`       | Decodes a MIME body to text through `decodeMIMEEncoding` and `resolveEncoding`, taking the charset from a free-form label.                                                                     |
| `decodeMIMEWords`     | function | `(text: string) => string`                                          | Decodes the RFC 2047 encoded words (`=?charset?B/Q?...?=`) in a header value, reading the Base64 (`B`) and quoted-printable (`Q`) forms alike.                                                 |
| `formatEmailAddress`  | function | `(name: string \| undefined, email: string \| undefined) => string` | Formats a display name and an email address into `"Name <email>"`, or into whichever half is present.                                                                                          |
| `inferExtension`      | function | `(mimeType?: string, fileName?: string) => string`                  | Infers an attachment's file extension from its file name or its MIME type, returning the extension with its leading dot and falling back to `.bin`.                                            |

```ts
import {
	success,
	failure,
	isSuccess,
	isFailure,
	truncateAtNull,
	readUTF16String,
	fileTimeToUTCString,
	toHexLower,
	readMicrosoftUUID,
	roundUpToMultiple,
	computeSectors,
	compareCFBName,
	isMSGFile,
	decodeBase64,
	encodeUTF8,
	decodeUTF8,
	decodeLatin1,
	decodeWindows1252,
	resolveEncoding,
	detectFormat,
	parseMIMEHeaders,
	decodeMIMEEncoding,
	decodeMIMEText,
	formatEmailAddress,
	inferExtension,
} from '@orkestrel/msg'

truncateAtNull('abc\0def') // 'abc'
toHexLower(255, 4) // '00ff'
roundUpToMultiple(10, 8) // 16
computeSectors(100, 64) // 2
compareCFBName('a', 'b') // negative
isMSGFile(new DataView(new Uint8Array(8).buffer)) // false — no CFB magic
detectFormat('message.eml', undefined) // 'eml'
isSuccess(success(1)) // true
isFailure(failure(new Error())) // true
decodeLatin1(new Uint8Array([65])) // 'A'
decodeWindows1252(new Uint8Array([65])) // 'A'
resolveEncoding('utf-8') // 'utf-8'
formatEmailAddress('A', 'a@x.dev') // 'A <a@x.dev>'
inferExtension('image/png') // '.png'
decodeMIMEEncoding('aGk=', 'base64') // Uint8Array of 'hi'
decodeMIMEText('aGk=', 'base64', 'utf-8') // 'hi'
encodeUTF8('hi') // Uint8Array
decodeUTF8(new Uint8Array([65])) // 'A'

const view = new DataView(new Uint8Array([0x48, 0x00, 0x69, 0x00]).buffer)
readUTF16String(view, 0, 2) // 'Hi'
fileTimeToUTCString(0, 0) // a UTC date string
readMicrosoftUUID(new Uint8Array(16), 0) // a UUID string
```

### Shapers

The value shapers from [`shapers.ts`](../src/core/shapers.ts) build a finished value out of an already-parsed source. `burnCFB` compiles a flat readonly entry graph into a standalone binary, without mutating the caller's descriptors. `extractMessage` and `extractMessageFromMSG` project a parsed MIME tree or a parsed MSG field tree into an `EmailMessage`.

| Shaper                  | Kind     | Signature                                            | Summary                                                                                                                                                                                |
| ----------------------- | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `burnCFB`               | function | `(entries: readonly MSGBurnerEntry[]) => Uint8Array` | Reconstitutes a valid CFB (Compound Binary File) binary from a flat list of `MSGBurnerEntry` descriptors — root storage at index 0, its children reachable through `children` indices. |
| `extractMessageFromMSG` | function | `(reader: MSGSourceInterface) => EmailMessage`       | Extracts one `EmailMessage` from the field data and attachments of a parsed MSG source; a corrupt attachment is skipped rather than fatal.                                             |
| `extractMessage`        | function | `(part: MIMEPart) => EmailMessage`                   | Extracts one `EmailMessage` by walking a parsed `MIMEPart` tree for its text, HTML, and attachments.                                                                                   |

```ts
import {
	burnCFB,
	extractMessage,
	extractMessageFromMSG,
	MSG_CATEGORY_ROOT,
	parseMIMEPart,
} from '@orkestrel/msg'
import type { MSGAttachment, MSGBurnerEntry, MSGFieldData } from '@orkestrel/msg'

const entries: readonly MSGBurnerEntry[] = [
	{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, length: 0 },
]
burnCFB(entries) // Uint8Array — a standalone CFB binary

const part = parseMIMEPart('Subject: Hi\n\nBody text')
extractMessage(part) // EmailMessage — { from: '', to: [], subject: 'Hi', text: 'Body text', ... }

const fields: MSGFieldData = { category: 'msg', subject: 'Hi' }
extractMessageFromMSG({
	parse: () => fields,
	attachment: (index: number): MSGAttachment => ({
		name: `a${index}`,
		bytes: new Uint8Array(0),
	}),
}) // EmailMessage
```

### Parsers

MIME-tree parsing from [`parsers.ts`](../src/core/parsers.ts) — the recursive coercion from raw text to a typed tree, built on `helpers.ts`'s header parser.

| Parser          | Kind     | Signature                                   | Summary                                                                                                   |
| --------------- | -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `parseMIMEPart` | function | `(raw: string, depth?: number) => MIMEPart` | Parses raw RFC 2822 / MIME text into a `MIMEPart` tree, throwing past `MIME_MAX_DEPTH` levels of nesting. |

```ts
import { parseMIMEPart } from '@orkestrel/msg'

parseMIMEPart('Subject: Hi\n\nBody text') // MIMEPart — { headers, body: 'Body text', parts: [] }
```

### Validators

The from-unknown guards from [`validators.ts`](../src/core/validators.ts). Each validates an arbitrary `unknown` value from scratch, against the `EmailChain`, `EmailMessage`, or `EmailAttachment` shape, the `EmailFormat` union, or the plain-record shape those checks are built on. `isMSGError` differs: it narrows a value that is already typed.

| Guard               | Kind     | Signature                                              | Summary                                                                                                                                                           |
| ------------------- | -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isRecord`          | function | `(value: unknown) => value is Record<string, unknown>` | Narrows an unknown value to a plain record: a total from-unknown guard, true for a non-null, non-array object.                                                    |
| `isEmailFormat`     | function | `(value: unknown) => value is EmailFormat`             | Narrows an unknown value to a valid `EmailFormat`: a total from-unknown guard, true for `'eml'` and `'msg'`.                                                      |
| `isEmailAttachment` | function | `(value: unknown) => value is EmailAttachment`         | Narrows an unknown value to an `EmailAttachment`: a total from-unknown guard over `name`, `mimeType`, and `bytes`.                                                |
| `isEmailMessage`    | function | `(value: unknown) => value is EmailMessage`            | Narrows an unknown value to an `EmailMessage`: a total from-unknown guard over every member, validating `attachments` recursively through `isEmailAttachment`.    |
| `isEmailChain`      | function | `(value: unknown) => value is EmailChain`              | Narrows an unknown value to an `EmailChain`: a total from-unknown guard over `format` and `messages`, validating `messages` recursively through `isEmailMessage`. |

```ts
import {
	isEmailAttachment,
	isEmailChain,
	isEmailFormat,
	isEmailMessage,
	isRecord,
} from '@orkestrel/msg'

isRecord({}) // true
isEmailFormat('eml') // true
isEmailAttachment({ name: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array() }) // true
isEmailMessage({
	from: '',
	to: [],
	cc: [],
	subject: '',
	date: undefined,
	text: '',
	html: '',
	attachments: [],
}) // true
isEmailChain({ format: 'eml', messages: [] }) // true
```

### Classes

The one implementing class, from [`MSG.ts`](../src/core/MSG.ts) — documented in full under its own
heading following this table. `MSGError` is a class too, and sits in the [`### Errors`](#errors)
table beside the guard that narrows to it.

| Class | Kind  | Summary                                                                                                                                                                         |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MSG` | class | Parses raw `.eml` or `.msg` file bytes into a structured `EmailChain`, exposing — for `.msg` input — the raw MAPI field tree, attachment binary access, and CFB reconstitution. |

### `MSG`

The implementing class of `MSGInterface`, from [`MSG.ts`](../src/core/MSG.ts). Construction is eager and total-or-throw. `new MSG(input, options?)` walks the CFB sector and directory chains with `DataView` for `.msg` input, bounds-checking every offset and cycle-guarding every chain. It runs the pure-ES MIME parser for `.eml` input. Input it cannot parse throws a typed `MSGError` rather than a raw `RangeError` — `UNSUPPORTED` for an unrecognized format, and `MALFORMED`, `CYCLE`, or `RANGE` for a structurally invalid one. `chain` exposes the parsed `EmailChain` for either format, and `chain.format` distinguishes them. `fields` exposes the raw MAPI field tree, present only for `'msg'` input. `attachment(index)` and `burn()` reconstitute different things and are never rewired into each other: `attachment(index)` rebuilds one embedded `.msg` from that attachment's own stored subtree, and `burn()` rebuilds the whole file the instance was constructed from. See [`## Methods`](#methods) for its public call-signature surface.

```ts
import { MSG } from '@orkestrel/msg'

const msg = new MSG({ bytes, name: 'message.eml' })
msg.options // {} when not configured; the encoding default is applied at read time
msg.chain.format // 'eml' | 'msg'
msg.chain.messages[0].text
msg.fields // undefined for 'eml' input; MSGFieldData for 'msg' input
```

### Factories

From [`factories.ts`](../src/core/factories.ts).

| Factory     | Kind     | Signature                                                                   | Summary                                                                                                                                                                                                                                      |
| ----------- | -------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMSG` | function | `(input: MSGInput, options?: MSGOptions) => Result<MSGInterface, MSGError>` | Creates an `MSGInterface` for raw `.eml` or `.msg` input and returns it inside a `Result`: every parse failure surfaces as a `Failure` carrying the `MSGError` instead of throwing, and an unexpected non-`MSGError` error still propagates. |

#### Parse an email file and read its format

```ts
import { createMSG, isSuccess } from '@orkestrel/msg'

const result = createMSG(bytes)
if (isSuccess(result)) {
	console.log(result.value.chain.format)
}
```

## Methods

The public methods of the behavioral interfaces this package publishes. `options`, `chain`, and `fields` are readonly properties of `MSGInterface`, Surface-documented earlier; each table here lists exactly its interface's call-signature members.

#### `MSGInterface`

| Method       | Returns         | Summary                                                                                                                                                                                                                                                          |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attachment` | `MSGAttachment` | Reads attachment binary content by zero-based index, returning its `name` and `bytes`. Requires `'msg'` input: `'eml'` input carries no MAPI field tree, so every index throws — read an `.eml` file's attachments from `chain.messages[0].attachments` instead. |
| `burn`       | `Uint8Array`    | Rebuilds the whole parsed message as a standalone CFB/`.msg` binary, from the directory entry list and allocated sector map read during construction.                                                                                                            |

#### `MSGSourceInterface`

| Method       | Returns         | Summary                                                                                   |
| ------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `parse`      | `MSGFieldData`  | Reads the parsed MAPI field tree `extractMessageFromMSG` projects into an `EmailMessage`. |
| `attachment` | `MSGAttachment` | Reads attachment binary content by zero-based index, returning its `name` and `bytes`.    |

```ts
import { createMSG, isSuccess } from '@orkestrel/msg'

const result = createMSG(bytes) // Uint8Array of a .msg file
if (isSuccess(result)) {
	const msg = result.value
	const first = msg.attachment(0) // { name, bytes } — throws MSGError('RANGE') if none exists
	const rebuilt = msg.burn() // Uint8Array — a standalone CFB/.msg binary
}
```

## Round-trip semantics

`burn()` and `burnCFB` are reconstitution, not byte-identity: for a parsed `.msg` `msg`, re-parsing `msg.burn()` yields an EQUIVALENT parsed model (`new MSG(msg.burn()).fields` structurally matches `msg.fields`, and `isMSGFile` passes on the rebuilt bytes) — the rebuilt binary is not guaranteed to be byte-identical to the original file. Sector padding, directory ordering, and unused-space contents may differ; only the parsed shape and CFB validity are guaranteed to round-trip.

## Embedded vs. top-level burn

Two burn paths exist and are never rewired into each other:

- **`attachment(index)`** — when an attachment is itself an embedded `.msg` (`innerMSGContent === true`), its stored directory entry selects that attachment's own storage subtree for CFB reconstitution.
- **`burn()`** — rebuilds the whole parsed message, from the directory entry list and allocated sector map the constructor read out of the input file.

A caller extracting an embedded `.msg` attachment and burning it standalone goes through `attachment()`; rebuilding the file `MSG` was constructed from goes through `burn()`.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value and type exports), the `MSGInterface` ↔ `MSG` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Parse an email file and read its format` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/MSG.test.ts`](../tests/src/core/MSG.test.ts) — construction (`.eml` / `.msg` / malformed input), `chain`, `fields`, `attachment`, `burn`, and the embedded-`.msg` extraction path.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createMSG`'s `Result` contract (`Success`/`Failure`, with parse failures surfaced as `Failure<MSGError>` rather than thrown).
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — `isMSGFile` / `decodeUTF8` / `detectFormat` / `parseMIMEPart` / `extractMessage` / `extractMessageFromMSG`, incl. `MIME_MAX_DEPTH` cycle guarding.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the `Result` constructors/guards, CFB byte/string/UUID readers, and MIME/text codecs.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — `burnCFB` validity, mini-stream/FAT/DIFAT boundaries, red-black directory ordering, cycle/name limits, and real-parser round trips.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — `isRecord` / `isEmailFormat` / `isEmailAttachment` / `isEmailMessage` / `isEmailChain` soundness on well-formed and malformed input.
- `MSGError` shape and `isMSGError` narrowing are covered across [`tests/src/core/MSG.test.ts`](../tests/src/core/MSG.test.ts), [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts), and [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — no standalone `errors.test.ts` file exists.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding contract, and the rule files its rule map names: `.claude/rules/typescript.md` § Errors and outcomes owns the `Result` and throw pattern, and `.claude/rules/documentation.md` § Parity owns documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
