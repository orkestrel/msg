# @orkestrel/msg

> A zero-dependency parser for Outlook `.msg` (CFB/OLE2 compound binary) and `.eml`
> (RFC 2822 / MIME) email files, projecting either format into one structured `EmailChain`.

Hand `createMSG` the raw file bytes plus an optional file name or MIME hint. It detects the
format, and the chain it returns carries the sender, recipients, subject, date, text and HTML
bodies, and decoded attachments. Each reader is written from scratch: the CFB side walks the
directory tree and extracts MAPI properties directly, and the MIME side walks the header block
and the nested MIME part tree. Part of the `@orkestrel` line.

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
		console.log(attachment.name, attachment.mimeType, attachment.bytes.length)
	}

	console.log(msg.fields) // MSGFieldData | undefined (undefined for 'eml')
	const rebuilt = msg.burn() // round-trip back into a CFB byte stream
	const embedded = msg.attachment(0) // extract an embedded .msg attachment
} else {
	console.error(result.error.code, result.error.message) // 'UNSUPPORTED' | 'MALFORMED' | ...
}
```

`createMSG` is synchronous and returns a `Result<MSGInterface, MSGError>`;
every parse failure surfaces as a `Failure<MSGError>` rather than a throw
(an unexpected non-`MSGError` error still propagates). Format is inferred
from the `name` / `mime` hints when supplied. When they are absent, raw
`Uint8Array`/`ArrayBuffer` input is always parsed as `.msg`; an `EmailInput`
with no hints is sniffed for the CFB magic header and parsed as `.msg` on a
match, `.eml` otherwise. The underlying `MSG` class (`new MSG(...)`) parses
eagerly and throws `MSGError` on malformed or unsupported input — use
`createMSG` for the non-throwing `Result` form.

## Guide

For the full surface — the `MSG` class, its supporting types (`EmailChain`,
`EmailMessage`, `EmailAttachment`, `MSGDirectoryEntry`, and friends), and the
CFB/MIME formats it implements — see [`guides/msg.md`](guides/msg.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
