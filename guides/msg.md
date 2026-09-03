# MSG

> A zero-dependency parser for Outlook `.msg` (CFB/OLE2 compound binary) and
> `.eml` (RFC 2822 / MIME) email files. Source: [`src/core`](../src/core).
> Surfaced through the `@src/core` barrel.

## Surface

One `MSG` class parses either format. Construction is eager: the constructor
either fully parses the input or throws a typed `MSGError`. A parsed instance
exposes the structured `chain` (`EmailChain`) for either format. For `.msg`
input it also exposes the raw MAPI field tree (`fields`) plus `attachment` and
`burn` access. A pure-ES encoding layer (Base64, UTF-8, Latin-1, Windows-1252,
quoted-printable, RFC 2047 encoded words) and the CFB sector and directory
machinery in `parsers.ts`, `helpers.ts`, and `shapers.ts` back both formats
without a `TextDecoder` dependency. The whole surface therefore stays usable in
the core's DOM/Node-free environment.

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

From [`types.ts`](../src/core/types.ts).

| Type                  | Kind      | Shape                                                                                                                               |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Success<T>`          | interface | `{ success: true, value }` — a successful `Result`.                                                                                 |
| `Failure<E>`          | interface | `{ success: false, error }` — a failed `Result`.                                                                                    |
| `Result<T, E>`        | type      | `Success<T> \| Failure<E>` — discriminated union for a safe operation outcome.                                                      |
| `MSGEncoding`         | type      | `'utf-8' \| 'utf-16le' \| 'windows-1252' \| 'latin1'` — decode encoding for non-Unicode MSG strings and MIME part bodies.           |
| `MSGErrorCode`        | type      | `'UNSUPPORTED' \| 'MALFORMED' \| 'CYCLE' \| 'RANGE' \| 'BURN'` — machine-readable {@link MSGError} classification.                  |
| `MSGFieldType`        | type      | `'string' \| 'unicode' \| 'binary' \| 'time' \| 'integer' \| 'boolean'` — MAPI property data type tag.                              |
| `MSGRecipientRole`    | type      | `'to' \| 'cc' \| 'bcc'` — recipient role in a message.                                                                              |
| `MSGDirectoryEntry`   | interface | `{ category, name, previousProperty, nextProperty, childProperty, startBlock, sizeBlock, children? }` — a CFB storage/stream entry. |
| `MSGMutableFieldData` | interface | Internal readonly accumulator for field extraction, written through `Object.assign` and narrowed to `MSGFieldData`.                 |
| `MSGNameIdEntry`      | interface | `{ useName, name?, propertySet?, propertyLid? }` — a resolved `__nameid_version1.0` named property entry.                           |
| `MSGBurnerEntry`      | interface | `{ name, category, length, binaryProvider?, children? }` — a flat CFB entry descriptor for `burnCFB`, root at index 0.              |
| `MSGBurnerLiteEntry`  | interface | `{ entry, left, right, child, firstSector, mini, red }` — internal red-black tree metadata used during CFB burn.                    |
| `MSGFieldData`        | interface | Parsed MSG field data for the root message, an attachment, or a recipient — email/recipient/attachment/contact/appointment fields.  |
| `MSGAttachment`       | interface | `{ name, bytes }` — extracted attachment binary content.                                                                            |
| `MSGSourceInterface`  | interface | `{ parse(): MSGFieldData, attachment(index): MSGAttachment }` — the parsed MSG source `extractMessageFromMSG` reads from.           |
| `EmailFormat`         | type      | `'eml' \| 'msg'` — supported email file format.                                                                                     |
| `MIMEHeader`          | interface | `{ value, params }` — a parsed MIME header's primary value and parameter map.                                                       |
| `MIMEPart`            | interface | `{ headers, body, parts }` — a recursive MIME part tree node.                                                                       |
| `EmailAttachment`     | interface | `{ name, mimeType, bytes }` — an extracted email attachment.                                                                        |
| `EmailMessage`        | interface | `{ from, to, cc, subject, date, text, html, attachments }` — a structured email message.                                            |
| `EmailChain`          | interface | `{ format, messages }` — the parsed email chain from a single file.                                                                 |
| `EmailInput`          | interface | `{ bytes, name?, mime? }` — raw email input handed to `createMSG`/`MSG`.                                                            |
| `MSGInput`            | type      | `Uint8Array \| ArrayBuffer \| EmailInput` — raw input accepted by `createMSG`/`new MSG()`.                                          |
| `MSGOptions`          | interface | `{ encoding? }` — configuration for creating an `MSGInterface` (default encoding `'windows-1252'`).                                 |
| `MSGInterface`        | interface | `{ options, chain, fields, attachment, burn }` — see [`## Methods`](#methods) below.                                                |

### Constants

The CFB layout offsets and sizes, the MSG/EML sniffing tables, the MAPI field name mappings, and the burner's geometry, from [`constants.ts`](../src/core/constants.ts). None of them carries runtime behavior. Every value is a fixed offset, a size, or a lookup table that the parsing and burning code in `MSG.ts`, `parsers.ts`, and `helpers.ts` reads.

| Constant                            | Kind  | Behavior                                                                                                                                         |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MSG_FILE_HEADER`                   | const | `readonly number[]`, frozen — the 8-byte CFB/OLE2 magic signature (`D0 CF 11 E0 A1 B1 1A E1`) a `.msg` file must open with.                      |
| `MSG_UNUSED_BLOCK`                  | const | `-1` — the FAT/SBAT sentinel for an unallocated sector.                                                                                          |
| `MSG_END_OF_CHAIN`                  | const | `-2` — the FAT/SBAT sentinel marking a sector chain's end.                                                                                       |
| `MSG_SECTOR_SIZE`                   | const | `0x0200` — the standard 512-byte CFB sector size, read when the header's sector shift is 9 and written by every burn.                            |
| `MSG_S_BIG_BLOCK_MARK`              | const | `9` — the header sector-shift value selecting `MSG_SECTOR_SIZE`.                                                                                 |
| `MSG_L_BIG_BLOCK_SIZE`              | const | `0x1000` — the large (4096-byte) CFB sector size, used when the header's sector shift is 12.                                                     |
| `MSG_L_BIG_BLOCK_MARK`              | const | `12` — the header sector-shift value selecting `MSG_L_BIG_BLOCK_SIZE`.                                                                           |
| `MSG_MINI_SECTOR_SIZE`              | const | `0x0040` — the 64-byte CFB mini-stream sector size, read and written by both paths.                                                              |
| `MSG_MINI_STREAM_CUTOFF`            | const | `0x1000` — the stream size at and above which a stream leaves the mini-stream for standard sectors.                                              |
| `MSG_HEADER_PROPERTY_START_OFFSET`  | const | `0x30` — header offset of the root directory sector's start.                                                                                     |
| `MSG_HEADER_BAT_START_OFFSET`       | const | `0x4c` — header offset of the DIFAT's first 109 FAT sector entries.                                                                              |
| `MSG_HEADER_BAT_COUNT_OFFSET`       | const | `0x2c` — header offset of the total FAT sector count.                                                                                            |
| `MSG_HEADER_SBAT_START_OFFSET`      | const | `0x3c` — header offset of the mini-FAT's first sector.                                                                                           |
| `MSG_HEADER_SBAT_COUNT_OFFSET`      | const | `0x40` — header offset of the mini-FAT sector count.                                                                                             |
| `MSG_HEADER_XBAT_START_OFFSET`      | const | `0x44` — header offset of the first DIFAT (XBAT) sector.                                                                                         |
| `MSG_HEADER_XBAT_COUNT_OFFSET`      | const | `0x48` — header offset of the DIFAT sector count.                                                                                                |
| `MSG_PROP_NO_INDEX`                 | const | `-1` — the directory-entry sentinel for "no such property" (previous/next/child).                                                                |
| `MSG_MAX_HIERARCHY_DEPTH`           | const | `64` — recursion cap on directory-tree traversal, guarding against a cyclic/hostile property chain.                                              |
| `MSG_DIRECTORY_ENTRY_SIZE`          | const | `0x0080` — the fixed 128-byte size of one CFB directory entry, read and written by both paths.                                                   |
| `MSG_PROP_NAME_SIZE_OFFSET`         | const | `0x40` — directory-entry offset of the entry name's UTF-16 byte length.                                                                          |
| `MSG_PROP_CATEGORY_OFFSET`          | const | `0x42` — directory-entry offset of the entry's object-category byte (the CFB object type byte).                                                  |
| `MSG_PROP_PREVIOUS_PROPERTY_OFFSET` | const | `0x44` — directory-entry offset of the red-black tree's previous sibling index.                                                                  |
| `MSG_PROP_NEXT_PROPERTY_OFFSET`     | const | `0x48` — directory-entry offset of the red-black tree's next sibling index.                                                                      |
| `MSG_PROP_CHILD_PROPERTY_OFFSET`    | const | `0x4c` — directory-entry offset of the first child storage index.                                                                                |
| `MSG_PROP_START_BLOCK_OFFSET`       | const | `0x74` — directory-entry offset of the entry's starting sector.                                                                                  |
| `MSG_PROP_SIZE_OFFSET`              | const | `0x78` — directory-entry offset of the entry's stream byte length.                                                                               |
| `MSG_CATEGORY_UNALLOCATED`          | const | `0` — directory entry category byte for an unallocated (free) slot.                                                                              |
| `MSG_CATEGORY_DIRECTORY`            | const | `1` — directory entry category byte for a storage (folder-like) entry.                                                                           |
| `MSG_CATEGORY_DOCUMENT`             | const | `2` — directory entry category byte for a stream (document) entry.                                                                               |
| `MSG_CATEGORY_ROOT`                 | const | `5` — directory entry category byte for the single root storage entry.                                                                           |
| `MSG_PREFIX_ATTACHMENT`             | const | `'__attach_version1.0'` — storage name prefix for an attachment entry.                                                                           |
| `MSG_PREFIX_RECIPIENT`              | const | `'__recip_version1.0'` — storage name prefix for a recipient entry.                                                                              |
| `MSG_PREFIX_DOCUMENT`               | const | `'__substg1.'` — stream name prefix for a MAPI property document.                                                                                |
| `MSG_PREFIX_NAMEID`                 | const | `'__nameid_version1.0'` — storage name for the named-property mapping table.                                                                     |
| `MSG_FIELD_NAME_MAPPING`            | const | `Readonly<Record<string, string>>` — MAPI property tag hex → short field name, for example `subject`.                                            |
| `MSG_FIELD_FULL_NAME_MAPPING`       | const | `Readonly<Record<string, string>>` — MAPI property tag hex → fully-qualified field name.                                                         |
| `MSG_FIELD_TYPE_MAPPING`            | const | `Readonly<Record<string, MSGFieldType>>` — MAPI property tag hex → `MSGFieldType` tag.                                                           |
| `MSG_FIELD_CLASS_ATTACHMENT_DATA`   | const | `'3701'` — the MAPI tag for an attachment's binary data stream.                                                                                  |
| `MSG_FIELD_DIR_TYPE_INNER_MSG`      | const | `'000d'` — the MAPI type tag identifying an embedded `.msg` attachment storage.                                                                  |
| `MSG_MAPI_RECIPIENT_TO`             | const | `1` — MAPI recipient-type value mapping to `MSGRecipientRole` `'to'`.                                                                            |
| `MSG_MAPI_RECIPIENT_CC`             | const | `2` — MAPI recipient-type value mapping to `'cc'`.                                                                                               |
| `MSG_MAPI_RECIPIENT_BCC`            | const | `3` — MAPI recipient-type value mapping to `'bcc'`.                                                                                              |
| `MSG_PIDLID_MAPPING`                | const | `Readonly<Record<string, Readonly<Record<number, string>>>>` — named-property set GUID → LID → field name.                                       |
| `MSG_BURNER_INTS_PER_SECTOR`        | const | `MSG_SECTOR_SIZE / 4` — 32-bit FAT/DIFAT entries per sector.                                                                                     |
| `MSG_BURNER_DIFAT_HEADER_SLOTS`     | const | `109` — DIFAT entries stored directly in the CFB header.                                                                                         |
| `MSG_BURNER_FAT_SECTOR_MARKER`      | const | `-3` — the FAT sentinel marking a sector as itself part of the FAT.                                                                              |
| `MSG_BURNER_DIFAT_SECTOR_MARKER`    | const | `-4` — the FAT sentinel marking a sector as part of the DIFAT.                                                                                   |
| `MSG_BURNER_NAME_MAX`               | const | `31` — the maximum UTF-16 code units a written directory entry name may hold.                                                                    |
| `MSG_BURNER_ROOT_CLSID`             | const | `readonly number[]`, frozen — the 16-byte CLSID (`0B 0D 02 00 00 00 00 00 C0 00 00 00 00 00 00 46`) `burnCFB` writes for the root storage entry. |
| `EML_EXTENSIONS`                    | const | `['.eml']` — file name extensions sniffed as `EmailFormat` `'eml'`.                                                                              |
| `MSG_EXTENSIONS`                    | const | `['.msg']` — file name extensions sniffed as `'msg'`.                                                                                            |
| `EML_MIME_TYPES`                    | const | `['message/rfc822']` — MIME types sniffed as `'eml'`.                                                                                            |
| `MSG_MIME_TYPES`                    | const | `['application/vnd.ms-outlook']` — MIME types sniffed as `'msg'`.                                                                                |
| `FALLBACK_CHARSET`                  | const | `'utf-8'` — the charset `resolveEncoding` falls back to when a label is unrecognized.                                                            |
| `FALLBACK_ATTACHMENT_NAME`          | const | `'attachment'` — the file name `extractMessage` falls back to for an attachment part carrying no `filename`/`name` parameter.                    |
| `MIME_EXTENSIONS`                   | const | `ReadonlyMap<string, string>` — MIME type → file extension, used by `inferExtension`.                                                            |
| `MIME_MAX_DEPTH`                    | const | `50` — recursion cap on `parseMIMEPart`'s multipart nesting.                                                                                     |
| `UTF8_SEQUENCE_MINIMUM`             | const | `Readonly<Record<number, number>>` — minimum code point per UTF-8 sequence length, for overlong-encoding rejection in `decodeUTF8`.              |
| `WINDOWS_1252_HIGH`                 | const | `readonly number[]` — the Windows-1252 code point table for bytes `0x80`-`0x9F`.                                                                 |

### Errors

From [`errors.ts`](../src/core/errors.ts) — every MSG/EML parsing or burning failure `throw`s (or, for `createMSG`, returns) an `MSGError` carrying a machine-readable `code`.

| Symbol       | Kind     | Signature                               | Behavior                                                                                                                   |
| ------------ | -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MSGError`   | class    | `new MSGError(code, message, context?)` | An error thrown or returned by the MSG/EML surfaces, carrying `{ code: MSGErrorCode, context?: Record<string, unknown> }`. |
| `isMSGError` | function | `(value: unknown) => value is MSGError` | Narrows an unknown caught (or `Failure.error`) value to an `MSGError`.                                                     |

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

| Helper                | Kind     | Signature                                                           | Behavior                                                                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `success`             | function | `<T>(value: T) => Success<T>`                                       | Constructs a `Success` wrapping `value`.                                                                                          |
| `failure`             | function | `<E>(error: E) => Failure<E>`                                       | Constructs a `Failure` wrapping `error`.                                                                                          |
| `isSuccess`           | function | `<T, E>(result: Result<T, E>) => result is Success<T>`              | Narrows a `Result` to `Success`.                                                                                                  |
| `isFailure`           | function | `<T, E>(result: Result<T, E>) => result is Failure<E>`              | Narrows a `Result` to `Failure`.                                                                                                  |
| `truncateAtNull`      | function | `(text: string) => string`                                          | Truncates `text` at its first `\0` character.                                                                                     |
| `readUTF16String`     | function | `(view: DataView, offset: number, charCount: number) => string`     | Reads a UTF-16LE string; throws `MSGError('MALFORMED')` when the range exceeds the view's bounds.                                 |
| `decodeText`          | function | `(bytes: Uint8Array, encoding?: MSGEncoding) => string`             | Decodes `bytes` into a string with a pure-ES decoder, dispatching on `encoding`. Default: `windows-1252`.                         |
| `fileTimeToUTCString` | function | `(low: number, high: number) => string`                             | Converts a Windows FILETIME (100-ns ticks since 1601, `BigInt`-precise) to a UTC date string.                                     |
| `toHexLower`          | function | `(value: number, length: number) => string`                         | Converts `value` to a zero-padded lowercase hex string of `length` digits.                                                        |
| `readMicrosoftUUID`   | function | `(bytes: Uint8Array, offset: number) => string`                     | Reads a mixed-endian Microsoft UUID starting at `offset` in `bytes`; throws `MSGError('RANGE')` past the array's bounds.          |
| `roundUpToMultiple`   | function | `(value: number, boundary: number) => number`                       | Rounds `value` up to the nearest multiple of `boundary` (a power of 2).                                                           |
| `computeSectors`      | function | `(bytes: number, sectorSize: number) => number`                     | Computes how many `sectorSize` sectors hold `bytes` (0 when `bytes <= 0`).                                                        |
| `compareCFBName`      | function | `(a: string, b: string) => number`                                  | CFB-compliant directory name comparator — by UTF-16 length, then uppercased code points.                                          |
| `isMSGFile`           | function | `(view: DataView) => boolean`                                       | `true` when `view`'s first 8 bytes match the CFB magic signature.                                                                 |
| `decodeBase64`        | function | `(text: string) => Uint8Array`                                      | Decodes a Base64 string into raw bytes.                                                                                           |
| `encodeUTF8`          | function | `(text: string) => Uint8Array`                                      | Encodes a string into UTF-8 bytes.                                                                                                |
| `decodeUTF8`          | function | `(bytes: Uint8Array) => string`                                     | WHATWG-style UTF-8 decode — an invalid sequence decodes as U+FFFD rather than throwing.                                           |
| `decodeLatin1`        | function | `(bytes: Uint8Array) => string`                                     | Decodes Latin-1 (ISO-8859-1) bytes into a string.                                                                                 |
| `decodeWindows1252`   | function | `(bytes: Uint8Array) => string`                                     | Decodes Windows-1252 bytes into a string, resolving the `0x80`-`0x9F` range through `WINDOWS_1252_HIGH`.                          |
| `resolveEncoding`     | function | `(label: string \| undefined) => MSGEncoding`                       | Resolves a charset label to an `MSGEncoding`, falling back to `FALLBACK_CHARSET`'s encoding when unrecognized.                    |
| `detectFormat`        | function | `(name?: string, mime?: string) => EmailFormat \| undefined`        | Derives `EmailFormat` from a file name and/or MIME type; `undefined` when neither hints at a format.                              |
| `parseMIMEHeaders`    | function | `(text: string) => ReadonlyMap<string, MIMEHeader>`                 | Parses an RFC 2822 / MIME header block, folding continuation lines.                                                               |
| `decodeMIMEEncoding`  | function | `(body: string, encoding: string) => Uint8Array`                    | Decodes a MIME body (`base64` / `quoted-printable` / passthrough) to raw bytes; throws `MSGError('MALFORMED')` on invalid Base64. |
| `decodeMIMEText`      | function | `(body: string, encoding: string, charset: string) => string`       | Decodes a MIME body to text through `decodeMIMEEncoding` and `resolveEncoding`.                                                   |
| `decodeMIMEWords`     | function | `(text: string) => string`                                          | Decodes RFC 2047 encoded words (`=?charset?B/Q?...?=`) in a header value.                                                         |
| `formatEmailAddress`  | function | `(name: string \| undefined, email: string \| undefined) => string` | Formats a display name + email into `"Name <email>"`, or whichever half is present.                                               |
| `inferExtension`      | function | `(mimeType?: string, fileName?: string) => string`                  | Infers a file extension from a file name or MIME type, falling back to `.bin`.                                                    |

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

| Shaper                  | Kind     | Signature                                            | Behavior                                                                                                                                                                               |
| ----------------------- | -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `burnCFB`               | function | `(entries: readonly MSGBurnerEntry[]) => Uint8Array` | Reconstitutes a valid CFB binary from a flat `MSGBurnerEntry` list (root at index 0); throws `MSGError('BURN')` for an invalid/cyclic graph or a name exceeding `MSG_BURNER_NAME_MAX`. |
| `extractMessageFromMSG` | function | `(reader: MSGSourceInterface) => EmailMessage`       | Extracts an `EmailMessage` from parsed MSG field data + attachment access; a corrupt attachment is skipped, not fatal.                                                                 |
| `extractMessage`        | function | `(part: MIMEPart) => EmailMessage`                   | Extracts an `EmailMessage` by walking a parsed `MIMEPart` tree for text/HTML/attachments.                                                                                              |

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

| Parser          | Kind     | Signature                                   | Behavior                                                                                                      |
| --------------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `parseMIMEPart` | function | `(raw: string, depth?: number) => MIMEPart` | Parses RFC 2822 / MIME text into a `MIMEPart` tree; throws `MSGError('CYCLE')` past `MIME_MAX_DEPTH` nesting. |

```ts
import { parseMIMEPart } from '@orkestrel/msg'

parseMIMEPart('Subject: Hi\n\nBody text') // MIMEPart — { headers, body: 'Body text', parts: [] }
```

### Validators

The from-unknown guards from [`validators.ts`](../src/core/validators.ts). Each validates an arbitrary `unknown` value from scratch, against the `EmailChain`, `EmailMessage`, or `EmailAttachment` shape, the `EmailFormat` union, or the plain-record shape those checks are built on. `isMSGError` differs: it narrows a value that is already typed.

| Guard               | Kind     | Narrows to                | Behavior                                                                                                                                                |
| ------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isRecord`          | function | `Record<string, unknown>` | Total from-unknown guard: `true` when `value` is a non-null, non-array object.                                                                          |
| `isEmailFormat`     | function | `EmailFormat`             | Total from-unknown guard: `true` when `value` is `'eml'` or `'msg'`.                                                                                    |
| `isEmailAttachment` | function | `EmailAttachment`         | Total from-unknown guard: `{ name, mimeType, bytes }`, all fields checked.                                                                              |
| `isEmailMessage`    | function | `EmailMessage`            | Total from-unknown guard: `{ from, to, cc, subject, date?, text, html, attachments }`, `attachments` recursively validated through `isEmailAttachment`. |
| `isEmailChain`      | function | `EmailChain`              | Total from-unknown guard: `{ format, messages }`, `messages` recursively validated through `isEmailMessage`.                                            |

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

| Factory     | Kind     | Signature                                                                   | Behavior                                                                                                                                                                                                                    |
| ----------- | -------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMSG` | function | `(input: MSGInput, options?: MSGOptions) => Result<MSGInterface, MSGError>` | Creates an `MSGInterface` for the given `.eml`/`.msg` input. Unlike `new MSG()`, every parse failure surfaces as a `Failure` carrying the `MSGError` instead of throwing; unexpected non-`MSGError` errors still propagate. |

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

| Method       | Returns         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attachment` | `MSGAttachment` | Reads attachment binary content by zero-based index, returning its `name` and `bytes`. Embedded `.msg` attachments reconstitute their stored directory subtree; ordinary attachments read their `dataId` stream directly. Requires `'msg'` input: `'eml'` input carries no MAPI field tree, so every index throws — read an `.eml` file's attachments from `chain.messages[0].attachments` instead. Throws `MSGError` (`RANGE`) when the index is out of bounds, and for every index on `'eml'` input. |
| `burn`       | `Uint8Array`    | Rebuilds the whole parsed `.msg` as a standalone CFB binary, from the directory entry list and allocated sector map read during construction. Throws `MSGError` (`BURN`) when the parsed structure (`.eml` input, or a missing root entry) cannot be reconstituted.                                                                                                                                                                                                                                    |

#### `MSGSourceInterface`

| Method       | Returns         | Behavior                                                                                    |
| ------------ | --------------- | ------------------------------------------------------------------------------------------- |
| `parse`      | `MSGFieldData`  | Returns the parsed MAPI field tree `extractMessageFromMSG` projects into an `EmailMessage`. |
| `attachment` | `MSGAttachment` | Reads attachment binary content by zero-based index, returning its `name` and `bytes`.      |

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
