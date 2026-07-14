# @orkestrel/msg

A zero-dependency Outlook `.msg` (CFB/OLE2) and `.eml` (RFC 2822/MIME) email
parser — extracts headers, bodies, recipients, and attachments into typed
structures. Feed it raw file bytes plus an optional file name or MIME hint; the
format is detected automatically and the file is parsed into a structured
`EmailChain` — sender, recipients, subject, date, text/HTML bodies, and
decoded attachments. `.msg` files are read via a from-scratch CFB (Compound
File Binary / OLE2) parser that walks the directory tree and extracts MAPI
properties directly; `.eml` files are read via a from-scratch RFC 2822/MIME
parser that walks the header block and the (possibly nested) MIME part tree.
A lower-level `MsgReader` / `MsgBurner` pair is also exposed for readers that
need direct CFB access — `MsgReader` parses a `.msg` binary into its raw
directory/property structure, and `MsgBurner` reconstitutes that structure
back into a valid CFB byte stream (a round-trip "burn"), useful for rebuilding
or re-serializing a `.msg` file after editing its parsed fields. It never
throws on malformed input, only a typed `MsgError` returned inside a
`Result`. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/msg
```

## Requirements

- Node.js >= 24
- ESM + CJS (dual-format build)
- No runtime dependencies

## Usage

```ts
import { createEmailParser, isSuccess } from '@orkestrel/msg'

const parser = createEmailParser()
const result = parser.parse({ bytes, name: 'message.msg' }) // bytes: Uint8Array

if (isSuccess(result)) {
	const chain = result.value
	console.log(chain.format) // 'msg' or 'eml'

	const message = chain.messages[0]
	console.log(message.from, message.to, message.subject)
	console.log(message.text) // plain-text body (includes quoted reply chain)
	console.log(message.html) // HTML body (includes quoted reply chain)

	for (const attachment of message.attachments) {
		console.log(attachment.name, attachment.mimeType, attachment.size)
	}
} else {
	console.error(result.error.code, result.error.message) // 'UNSUPPORTED' | 'MALFORMED' | ...
}
```

`parse` is synchronous and returns a `Result<EmailChain, MsgError>` — never
throws. Format is inferred from the `name` / `mime` hints when supplied, or
detected from the byte content itself (CFB header for `.msg`, RFC 2822 header
block for `.eml`) when they are absent.

For direct access to the underlying `.msg` CFB structure — and to rebuild a
`.msg` binary after editing its parsed fields — use `createMsgReader` and
`createMsgBurner`:

```ts
import { createMsgReader, createMsgBurner } from '@orkestrel/msg'

const reader = createMsgReader(buffer) // ArrayBuffer or Uint8Array
const data = reader.parse() // raw directory/property structure
const rebuilt = reader.burn() // round-trip back into a CFB byte stream

const burner = createMsgBurner()
const binary = burner.burn(entries) // build a CFB byte stream from entry descriptors
```

## Guide

For the full surface — the `EmailParser`, `MsgReader`, and `MsgBurner`
classes, their supporting types (`EmailChain`, `EmailMessage`,
`EmailAttachment`, `MsgDirectoryEntry`, and friends), and the CFB/MIME formats
they implement — see [`guides/src/msg.md`](guides/src/msg.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
