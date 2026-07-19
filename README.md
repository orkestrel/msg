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
`createMSG` never throws on malformed input — it returns a typed `MSGError`
inside a `Result`. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/msg
```

## Requirements

- Node.js >= 22
- ESM + CJS (dual-format build)
- No runtime dependencies

## Usage

```ts
import { createMSG, isSuccess } from '@orkestrel/msg'

const result = createMSG({ bytes, name: 'message.msg' }) // bytes: Uint8Array

if (isSuccess(result)) {
	const msg = result.value
	console.log(msg.chain.format) // 'msg' or 'eml'

	const message = msg.chain.messages[0]
	console.log(message.from, message.to, message.subject)
	console.log(message.text) // plain-text body (includes quoted reply chain)
	console.log(message.html) // HTML body (includes quoted reply chain)

	for (const attachment of message.attachments) {
		console.log(attachment.name, attachment.mimeType, attachment.size)
	}

	console.log(msg.fields) // MSGFieldData | undefined (undefined for 'eml')
	const rebuilt = msg.burn() // round-trip back into a CFB byte stream
	const embedded = msg.attachment(0) // extract an embedded .msg attachment
} else {
	console.error(result.error.code, result.error.message) // 'UNSUPPORTED' | 'MALFORMED' | ...
}
```

`createMSG` is synchronous and returns a `Result<MSGInterface, MSGError>` —
never throws. Format is inferred from the `name` / `mime` hints when
supplied, or detected from the byte content itself (CFB header for `.msg`,
RFC 2822 header block for `.eml`) when they are absent. The underlying `MSG`
class (`new MSG(...)`) parses eagerly and throws `MSGError` on malformed or
unsupported input — use `createMSG` for the non-throwing `Result` form.

## Guide

For the full surface — the `MSG` class, its supporting types (`EmailChain`,
`EmailMessage`, `EmailAttachment`, `MSGDirectoryEntry`, and friends), and the
CFB/MIME formats it implements — see [`guides/src/msg.md`](guides/src/msg.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
