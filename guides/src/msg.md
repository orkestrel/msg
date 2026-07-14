# MSG

> A zero-dependency parser for Outlook `.msg` (CFB/OLE2 compound binary) and
> `.eml` (RFC 2822 / MIME) email files — extracts headers, bodies,
> recipients, and attachments into typed structures, with `.msg` round-trip
> rebuild. `MSGReader` walks a CFB compound file's sector/property chains
> directly with `DataView`, extracting message fields, recipients, and
> attachments (every offset bounds-checked, every chain cycle-guarded — a
> malformed input throws a typed `MSGError` rather than a raw `RangeError`).
> `MSGBurner` is the inverse: it reconstitutes a flat CFB entry list back
> into a valid compound binary, used to extract an embedded `.msg`
> attachment as a standalone file. `EmailParser` unifies both formats behind
> one call: it sniffs `.eml` vs `.msg` from a file name, MIME type, or the
> CFB magic header, and returns a `Result<EmailChain, MSGError>` so a
> malformed file never throws across that boundary. A pure-ES encoding layer
> (Base64, UTF-8, Latin-1, Windows-1252, quoted-printable, RFC 2047 encoded
> words) backs both formats without a `TextDecoder` dependency, so the whole
> surface stays usable in the core's DOM/Node-free environment.
> Source: [`src/core`](../../src/core). Surfaced through the `@src/core`
> barrel.

## Surface

Parse a raw file's bytes without knowing its format ahead of time — `.eml`
or `.msg` — and narrow the `Result` before touching the parsed chain:

```ts
import { createEmailParser, isSuccess } from '@orkestrel/msg'

const parser = createEmailParser()
const result = parser.parse({ bytes, name: 'message.eml' })
if (isSuccess(result)) {
	const { messages } = result.value
	console.log(messages[0].subject)
	console.log(messages[0].attachments)
}
```

### Types

| Type                    | Kind      | Shape                                                                                                                        |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Success<T>`            | interface | `{ success: true, value }` — a successful `Result`.                                                                          |
| `Failure<E>`            | interface | `{ success: false, error }` — a failed `Result`.                                                                             |
| `Result<T, E>`          | type      | `Success<T> \| Failure<E>` — discriminated union for a safe operation outcome.                                               |
| `MSGEncoding`           | type      | `'utf-8' \| 'utf-16le' \| 'windows-1252' \| 'latin1'` — decode encoding for non-Unicode MSG strings and MIME part bodies.    |
| `MSGErrorCode`          | type      | `'UNSUPPORTED' \| 'MALFORMED' \| 'CYCLE' \| 'RANGE' \| 'BURN'` — machine-readable {@link MSGError} classification.           |
| `MSGDirectoryEntryType` | type      | `'root' \| 'directory' \| 'document' \| 'unallocated'` — CFB directory entry lifecycle type.                                 |
| `MSGFieldType`          | type      | `'string' \| 'unicode' \| 'binary' \| 'time' \| 'integer' \| 'boolean'` — MAPI property data type tag.                       |
| `MSGRecipientRole`      | type      | `'to' \| 'cc' \| 'bcc'` — recipient role in a message.                                                                       |
| `MSGDirectoryEntry`     | interface | `{ type, name, previousProperty, nextProperty, childProperty, startBlock, sizeBlock, children? }` — one CFB directory entry. |
| `MSGMutableFieldData`   | interface | Internal mutable field accumulator narrowed to `MSGFieldData` at the public boundary.                                        |
| `MSGNameIdEntry`        | interface | `{ useName, name?, propertySet?, propertyLid? }` — resolved named property entry.                                            |
| `MSGBurnerEntry`        | interface | `{ name, type, length, binaryProvider?, children? }` — flat CFB entry descriptor for `MSGBurner`.                            |
| `MSGBurnerLiteEntry`    | interface | Internal red-black tree + sector metadata wrapping one `MSGBurnerEntry` during burn.                                         |
| `MSGBurnerInterface`    | interface | The CFB binary writer contract — `burn` reconstitutes entries into a CFB byte stream.                                        |
| `MSGFieldData`          | interface | Parsed field data for a root message, attachment, or recipient (subject, body, headers, attachments, recipients, ...).       |
| `MSGAttachment`         | interface | `{ fileName, content }` — extracted attachment binary content.                                                               |
| `MSGReaderOptions`      | interface | `{ encoding? }` — non-Unicode string decode encoding (default `'windows-1252'`).                                             |
| `MSGReaderInterface`    | interface | The stateful `.msg` file reader contract — `parse` / `attachment` / `burn`.                                                  |
| `EmailFormat`           | type      | `'eml' \| 'msg'` — supported email file format.                                                                              |
| `MIMEHeader`            | interface | `{ value, params }` — one parsed MIME header with its parameter map.                                                         |
| `MIMEPart`              | interface | `{ headers, body, parts }` — recursive MIME part tree node.                                                                  |
| `EmailAttachment`       | interface | `{ name, mimeType, size, bytes }` — extracted email attachment.                                                              |
| `EmailMessage`          | interface | `{ from, to, cc, subject, date, text, html, attachments }` — structured extracted message.                                   |
| `EmailChain`            | interface | `{ format, messages }` — parsed email chain from a single file.                                                              |
| `EmailInput`            | interface | `{ bytes, name?, mime? }` — raw email input handed to an `EmailParser`.                                                      |
| `EmailParserOptions`    | interface | `{ encoding? }` — MIME part body decode encoding (default `'utf-8'`).                                                        |
| `EmailParserInterface`  | interface | The email file parser contract — `parse` an `EmailInput` into a `Result<EmailChain, MSGError>`, plus `options`.              |

```ts
import type { EmailParserOptions, MSGReaderOptions } from '@orkestrel/msg'

const readerOptions: MSGReaderOptions = { encoding: 'windows-1252' }
const parserOptions: EmailParserOptions = { encoding: 'utf-8' }
```

### Constants

| API                                 | Kind  | Summary                                                               |
| ----------------------------------- | ----- | --------------------------------------------------------------------- |
| `MSG_FILE_HEADER`                   | const | CFB magic header bytes (`0xD0CF11E0A1B11AE1`).                        |
| `MSG_UNUSED_BLOCK`                  | const | Sentinel for unused blocks in the FAT.                                |
| `MSG_END_OF_CHAIN`                  | const | Sentinel for end-of-chain in the FAT.                                 |
| `MSG_S_BIG_BLOCK_SIZE`              | const | Small sector size (512 bytes).                                        |
| `MSG_S_BIG_BLOCK_MARK`              | const | Small sector size mark in the header (byte at offset 30).             |
| `MSG_L_BIG_BLOCK_SIZE`              | const | Large sector size (4096 bytes).                                       |
| `MSG_L_BIG_BLOCK_MARK`              | const | Large sector size mark in the header (byte at offset 30).             |
| `MSG_SMALL_BLOCK_SIZE`              | const | Mini-stream sector size (64 bytes).                                   |
| `MSG_BIG_BLOCK_MIN_DOC_SIZE`        | const | Threshold below which data is stored in the mini-stream.              |
| `MSG_HEADER_PROPERTY_START_OFFSET`  | const | Header offset: property (directory) start sector.                     |
| `MSG_HEADER_BAT_START_OFFSET`       | const | Header offset: BAT sector array start.                                |
| `MSG_HEADER_BAT_COUNT_OFFSET`       | const | Header offset: BAT sector count.                                      |
| `MSG_HEADER_SBAT_START_OFFSET`      | const | Header offset: SBAT start sector.                                     |
| `MSG_HEADER_SBAT_COUNT_OFFSET`      | const | Header offset: SBAT sector count.                                     |
| `MSG_HEADER_XBAT_START_OFFSET`      | const | Header offset: XBAT (DIFAT) start sector.                             |
| `MSG_HEADER_XBAT_COUNT_OFFSET`      | const | Header offset: XBAT (DIFAT) sector count.                             |
| `MSG_PROP_NO_INDEX`                 | const | No child/sibling index sentinel.                                      |
| `MSG_MAX_HIERARCHY_DEPTH`           | const | Maximum directory-hierarchy recursion depth in the reader (64).       |
| `MSG_PROPERTY_SIZE`                 | const | Directory entry size in bytes.                                        |
| `MSG_PROP_NAME_SIZE_OFFSET`         | const | Offset within a directory entry: name byte length.                    |
| `MSG_PROP_TYPE_OFFSET`              | const | Offset within a directory entry: object type byte.                    |
| `MSG_PROP_PREVIOUS_PROPERTY_OFFSET` | const | Offset within a directory entry: left sibling index.                  |
| `MSG_PROP_NEXT_PROPERTY_OFFSET`     | const | Offset within a directory entry: right sibling index.                 |
| `MSG_PROP_CHILD_PROPERTY_OFFSET`    | const | Offset within a directory entry: child index.                         |
| `MSG_PROP_START_BLOCK_OFFSET`       | const | Offset within a directory entry: start sector of stream data.         |
| `MSG_PROP_SIZE_OFFSET`              | const | Offset within a directory entry: stream byte length.                  |
| `MSG_TYPE_UNALLOCATED`              | const | Directory entry type: unallocated.                                    |
| `MSG_TYPE_DIRECTORY`                | const | Directory entry type: storage (folder).                               |
| `MSG_TYPE_DOCUMENT`                 | const | Directory entry type: stream (document).                              |
| `MSG_TYPE_ROOT`                     | const | Directory entry type: root storage.                                   |
| `MSG_PREFIX_ATTACHMENT`             | const | Name prefix for attachment storage entries.                           |
| `MSG_PREFIX_RECIPIENT`              | const | Name prefix for recipient storage entries.                            |
| `MSG_PREFIX_DOCUMENT`               | const | Name prefix for document (substg) stream entries.                     |
| `MSG_PREFIX_NAMEID`                 | const | Name prefix for named property mapping storage.                       |
| `MSG_FIELD_NAME_MAPPING`            | const | MAPI property tag to field name mapping.                              |
| `MSG_FIELD_FULL_NAME_MAPPING`       | const | Full 8-char property tag to field name mapping (for compound tags).   |
| `MSG_FIELD_TYPE_MAPPING`            | const | MAPI property type tag to decode type mapping.                        |
| `MSG_FIELD_CLASS_ATTACHMENT_DATA`   | const | Attachment data class identifier.                                     |
| `MSG_FIELD_DIR_TYPE_INNER_MSG`      | const | Directory field type indicating an embedded MSG.                      |
| `MSG_MAPI_RECIPIENT_TO`             | const | MAPI recipient type: TO.                                              |
| `MSG_MAPI_RECIPIENT_CC`             | const | MAPI recipient type: CC.                                              |
| `MSG_MAPI_RECIPIENT_BCC`            | const | MAPI recipient type: BCC.                                             |
| `MSG_PIDLID_MAPPING`                | const | PidLid property set GUID to LID-to-field-name mapping.                |
| `MSG_BURNER_SECTOR_SIZE`            | const | Standard CFB sector size in bytes (512).                              |
| `MSG_BURNER_MINI_SECTOR_SIZE`       | const | CFB mini-stream sector size in bytes (64).                            |
| `MSG_BURNER_MINI_STREAM_CUTOFF`     | const | Threshold below which streams are stored in the mini-stream (4096).   |
| `MSG_BURNER_INTS_PER_SECTOR`        | const | Number of 32-bit integers per standard sector (128).                  |
| `MSG_BURNER_DIFAT_HEADER_SLOTS`     | const | Maximum DIFAT entries stored in the CFB header (109).                 |
| `MSG_BURNER_DIR_ENTRY_SIZE`         | const | CFB directory entry size in bytes (128).                              |
| `MSG_BURNER_FAT_SECTOR_MARKER`      | const | FAT sector marker: this sector holds FAT data (-3).                   |
| `MSG_BURNER_DIFAT_SECTOR_MARKER`    | const | DIFAT sector marker: this sector holds DIFAT data (-4).               |
| `MSG_BURNER_NAME_MAX`               | const | Maximum UTF-16 code units allowed in a CFB directory entry name (31). |
| `MSG_BURNER_ROOT_CLSID`             | const | Root entry CLSID for MSG compound files.                              |
| `EML_EXTENSIONS`                    | const | File extensions recognized as RFC 2822 / MIME email files (`.eml`).   |
| `MSG_EXTENSIONS`                    | const | File extensions recognized as Outlook binary email files (`.msg`).    |
| `EML_MIME_TYPES`                    | const | MIME types recognized as RFC 2822 / MIME email files.                 |
| `MSG_MIME_TYPES`                    | const | MIME types recognized as Outlook binary email files.                  |
| `FALLBACK_CHARSET`                  | const | Default charset for decoding MIME part bodies (`'utf-8'`).            |
| `FALLBACK_ATTACHMENT_NAME`          | const | Default file name for attachments without an explicit name.           |
| `MIME_EXTENSIONS`                   | const | Common MIME types to file extensions mapping.                         |
| `MIME_MAX_DEPTH`                    | const | Maximum multipart nesting depth accepted by `parseMIMEPart` (50).     |
| `WINDOWS_1252_HIGH`                 | const | Windows-1252 high-byte (0x80-0x9F) to Unicode code point lookup.      |
| `UTF8_SEQUENCE_MINIMUM`             | const | Minimum valid code point per UTF-8 sequence length (overlong guard).  |

```ts
import {
	FALLBACK_CHARSET,
	MIME_MAX_DEPTH,
	MSG_BURNER_NAME_MAX,
	MSG_FILE_HEADER,
} from '@orkestrel/msg'

MSG_FILE_HEADER.length // 8 - the CFB magic header byte count
MIME_MAX_DEPTH // 50 - guards parseMIMEPart against a hostile multipart tree
MSG_BURNER_NAME_MAX // 31 - max UTF-16 units in a CFB directory entry name
FALLBACK_CHARSET // 'utf-8' - default MIME part body charset
```

### Errors

| API          | Kind     | Summary                                                      |
| ------------ | -------- | ------------------------------------------------------------ |
| `MSGError`   | class    | Carries a `MSGErrorCode` + optional `context`.               |
| `isMSGError` | function | Narrow a caught (or `Failure.error`) value to an `MSGError`. |

```ts
import { isMSGError, MSGError } from '@orkestrel/msg'

try {
	throw new MSGError('MALFORMED', 'bad Base64 in a MIME part', { char: '#' })
} catch (error) {
	if (isMSGError(error)) error.code // 'MALFORMED'
}
```

### Helpers

| API                     | Kind     | Summary                                                                     |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `success`               | function | Construct a `Success` wrapping a value.                                     |
| `failure`               | function | Construct a `Failure` wrapping an error.                                    |
| `isSuccess`             | function | Narrow a `Result` to `Success`.                                             |
| `isFailure`             | function | Narrow a `Result` to `Failure`.                                             |
| `isRecord`              | function | Narrow an unknown value to a plain record.                                  |
| `isMSGFile`             | function | Validate that a `DataView` starts with the CFB magic header.                |
| `removeTrailingNull`    | function | Remove trailing null characters from a string.                              |
| `readUTF16String`       | function | Read a UTF-16LE string from a `DataView`.                                   |
| `readANSIString`        | function | Read a non-Unicode (PT_STRING8) string, decoded per `MSGEncoding`.          |
| `fileTimeToUTCString`   | function | Convert a Windows FILETIME to a UTC date string.                            |
| `toHexLower`            | function | Convert a number to a lowercase, zero-padded hex string.                    |
| `msftUUIDStringify`     | function | Stringify a mixed-endian Microsoft UUID from a byte array.                  |
| `roundUpToMultiple`     | function | Round a value up to the nearest multiple of a power-of-2 boundary.          |
| `sectorsNeeded`         | function | Compute how many sectors are needed to hold a given byte count.             |
| `compareCFBName`        | function | CFB-compliant directory name comparator.                                    |
| `decodeBase64`          | function | Decode a Base64 string into raw bytes without `atob`.                       |
| `encodeUTF8`            | function | Encode a string into UTF-8 bytes, handling surrogate pairs.                 |
| `decodeUTF8`            | function | Decode UTF-8 bytes into a string, WHATWG-style (invalid → U+FFFD).          |
| `decodeLatin1`          | function | Decode Latin-1 (ISO-8859-1) bytes into a string.                            |
| `decodeWindows1252`     | function | Decode Windows-1252 bytes into a string.                                    |
| `resolveEncoding`       | function | Resolve a free-form charset label to a supported `MSGEncoding`.             |
| `isEmailFormat`         | function | Narrow an unknown value to a valid `EmailFormat`.                           |
| `detectFormat`          | function | Derive the `EmailFormat` from a file name and/or MIME type.                 |
| `parseMIMEHeaders`      | function | Parse headers from a raw RFC 2822 / MIME header text block.                 |
| `parseMIMEPart`         | function | Parse a raw RFC 2822 / MIME text string into a `MIMEPart` tree.             |
| `decodeMIMEEncoding`    | function | Decode a MIME-encoded body string into a raw byte array.                    |
| `decodeMIMEText`        | function | Decode a MIME-encoded body into a text string, given an encoding + charset. |
| `decodeMIMEWords`       | function | Decode RFC 2047 encoded words (`=?charset?B/Q?...?=`) in header values.     |
| `formatEmailAddress`    | function | Format a name and email into a standard composite address.                  |
| `extractMessageFromMSG` | function | Extract a single `EmailMessage` from a parsed `MSGReader`.                  |
| `extractMessage`        | function | Extract a single `EmailMessage` from a top-level `MIMEPart`.                |
| `inferExtension`        | function | Infer a file extension from a MIME type and/or file name.                   |

```ts
import { failure, isFailure, isRecord, isSuccess, success } from '@orkestrel/msg'

const result = success(42)
isSuccess(result) // true
isFailure(result) // false
isRecord(result) // true - a plain { success, value } object
const failed = failure(new Error('nope'))
isFailure(failed) // true
```

```ts
import {
	compareCFBName,
	fileTimeToUTCString,
	isMSGFile,
	msftUUIDStringify,
	readANSIString,
	readUTF16String,
	removeTrailingNull,
	roundUpToMultiple,
	sectorsNeeded,
	toHexLower,
} from '@orkestrel/msg'

const view = new DataView(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer)
isMSGFile(view) // true - CFB magic header present
removeTrailingNull('subject\0\0') // 'subject'
readUTF16String(view, 0, 4) // decodes 4 UTF-16 code units from the header bytes
readANSIString(new Uint8Array([0x41, 0x42]), 'latin1') // 'AB'
fileTimeToUTCString(0, 0) // FILETIME(0,0) as a UTC date string
toHexLower(255, 2) // 'ff'
msftUUIDStringify(new Uint8Array(16), 0) // '00000000-0000-0000-0000-000000000000'
roundUpToMultiple(10, 8) // 16
sectorsNeeded(10, 512) // 1
compareCFBName('a', 'ab') // negative - shorter name sorts first
```

```ts
import {
	decodeBase64,
	decodeLatin1,
	decodeUTF8,
	decodeWindows1252,
	encodeUTF8,
	resolveEncoding,
} from '@orkestrel/msg'

decodeBase64('SGVsbG8=') // Uint8Array [72, 101, 108, 108, 111]
encodeUTF8('A') // Uint8Array [65]
decodeUTF8(new Uint8Array([65])) // 'A'
decodeLatin1(new Uint8Array([0xe9])) // 'é'
decodeWindows1252(new Uint8Array([0x93])) // '“'
resolveEncoding('ISO-8859-1') // 'latin1'
```

```ts
import {
	decodeMIMEEncoding,
	decodeMIMEText,
	detectFormat,
	extractMessage,
	extractMessageFromMSG,
	formatEmailAddress,
	inferExtension,
	isEmailFormat,
	parseMIMEHeaders,
	parseMIMEPart,
} from '@orkestrel/msg'
import { createMSGReader } from '@orkestrel/msg'

isEmailFormat('eml') // true
detectFormat('message.eml', undefined) // 'eml'
formatEmailAddress('Ada Lovelace', 'ada@example.com') // 'Ada Lovelace <ada@example.com>'
const headers = parseMIMEHeaders('Content-Type: text/plain; charset=utf-8\n')
headers.get('content-type')?.value // 'text/plain'
const root = parseMIMEPart('Content-Type: text/plain\n\nhello')
extractMessage(root).text // 'hello'
decodeMIMEEncoding('aGVsbG8=', 'base64') // Uint8Array - decoded 'hello'
decodeMIMEText('aGVsbG8=', 'base64', 'utf-8') // 'hello'
inferExtension('image/png') // '.png'

const reader = createMSGReader(buffer)
extractMessageFromMSG(reader) // structured EmailMessage from a parsed .msg
```

### Factories

| API                 | Kind     | Builds…                                                    |
| ------------------- | -------- | ---------------------------------------------------------- |
| `createMSGReader`   | function | A working `MSGReaderInterface`, backed by `MSGReader`.     |
| `createMSGBurner`   | function | A working `MSGBurnerInterface`, backed by `MSGBurner`.     |
| `createEmailParser` | function | A working `EmailParserInterface`, backed by `EmailParser`. |

```ts
import { createMSGReader } from '@orkestrel/msg'

const reader = createMSGReader(buffer)
const data = reader.parse()
console.log(data.kind)
```

```ts
import { createMSGBurner } from '@orkestrel/msg'

const burner = createMSGBurner()
const binary = burner.burn(entries)
```

```ts
import { createEmailParser, isSuccess } from '@orkestrel/msg'

const parser = createEmailParser()
const result = parser.parse({ bytes, name: 'message.eml' })
if (isSuccess(result)) {
	console.log(result.value.messages[0].subject)
}
```

### Entities

| API           | Kind  | Summary                                                                                              |
| ------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `MSGReader`   | class | The stateful `.msg` file reader — implements `MSGReaderInterface`, parses CFB/OLE2 compound files.   |
| `MSGBurner`   | class | The CFB binary writer — implements `MSGBurnerInterface`, reconstitutes entries into a compound file. |
| `EmailParser` | class | The email file parser — implements `EmailParserInterface`, unifies `.eml` and `.msg` into a chain.   |

## Methods

The public methods of `MSGReaderInterface`, `MSGBurnerInterface`, and
`EmailParserInterface` — each class's full method surface (AGENTS §22). The
`readonly options` data member on `EmailParserInterface` stays off the
method table below.

#### `MSGReaderInterface`

| Method       | Returns         | Behavior                                                                                                                                                                                                                    |
| ------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse`      | `MSGFieldData`  | Parse the MSG file and return extracted field data (memoized — a second call returns the same result). Throws `MSGError` with code `UNSUPPORTED`, `MALFORMED`, `CYCLE`, or `RANGE` when the compound file cannot be parsed. |
| `attachment` | `MSGAttachment` | Read attachment binary content by zero-based index. Throws `MSGError` with code `RANGE` when the index is out of bounds.                                                                                                    |
| `burn`       | `Uint8Array`    | Rebuild the parsed MSG as a standalone CFB/.msg binary. Throws `MSGError` with code `BURN` when the parsed structure cannot be reconstituted.                                                                               |

```ts
import { createMSGReader, isMSGError } from '@orkestrel/msg'

const reader = createMSGReader(buffer)
const data = reader.parse() // MSGFieldData - subject, body, attachments, recipients
const first = reader.attachment(0) // { fileName, content } for the first attachment
const rebuilt = reader.burn() // standalone CFB/.msg binary

try {
	createMSGReader(new Uint8Array([1, 2, 3])).parse()
} catch (error) {
	if (isMSGError(error) && error.code === 'UNSUPPORTED') {
		console.log('not a recognized MSG file')
	}
}
```

#### `MSGBurnerInterface`

| Method | Returns      | Behavior                                                                                                                                                                                    |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `burn` | `Uint8Array` | Write a flat CFB entry list (root storage at index 0) to a complete CFB byte stream. Throws `MSGError` with code `BURN` when an entry name exceeds `MSG_BURNER_NAME_MAX` UTF-16 code units. |

```ts
import { createMSGBurner } from '@orkestrel/msg'

const burner = createMSGBurner()
const binary = burner.burn([{ name: 'Root Entry', type: 5, length: 0, children: [] }])
```

#### `EmailParserInterface`

| Method  | Returns                        | Behavior                                                                                                                                                                                                                                    |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `Result<EmailChain, MSGError>` | Parse raw `.eml` or `.msg` bytes into a structured `EmailChain`, wrapped as `Success`/`Failure` — never throws. `Failure.error` carries `MSGError` code `UNSUPPORTED` when the format cannot be determined, `MALFORMED` when parsing fails. |

```ts
import { createEmailParser, isFailure, isSuccess } from '@orkestrel/msg'

const parser = createEmailParser()
const result = parser.parse({ bytes, name: 'message.msg' })
if (isSuccess(result)) {
	const { messages } = result.value
	console.log(messages[0].text)
	console.log(messages[0].attachments)
} else if (isFailure(result)) {
	console.log(result.error.code) // 'UNSUPPORTED' | 'MALFORMED'
}
```
