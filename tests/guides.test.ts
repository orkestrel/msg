// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findDrift,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import type { MSGAttachment, MSGBurnerEntry, MSGFieldData } from '@src/core'
import {
	burnCFB,
	compareCFBName,
	computeSectors,
	createMSG,
	decodeLatin1,
	decodeMIMEEncoding,
	decodeMIMEText,
	decodeUTF8,
	decodeWindows1252,
	detectFormat,
	encodeUTF8,
	extractMessage,
	extractMessageFromMSG,
	failure,
	fileTimeToUTCString,
	formatEmailAddress,
	inferExtension,
	isEmailAttachment,
	isEmailChain,
	isEmailFormat,
	isEmailMessage,
	isFailure,
	isMSGError,
	isMSGFile,
	isRecord,
	isSuccess,
	MSG,
	MSG_CATEGORY_ROOT,
	MSGError,
	parseMIMEPart,
	readMicrosoftUUID,
	readUTF16String,
	resolveEncoding,
	roundUpToMultiple,
	success,
	toHexLower,
	truncateAtNull,
} from '@src/core'
import { readFixture } from './setupServer.js'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/msg.md'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/msg': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files these checks read. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md', 'README.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })
const own = requireValue(
	manifest.find((entry) => entry.spec === GUIDE_SPEC),
	`Missing manifest row: ${GUIDE_SPEC}`,
)

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

// The example half of the equality case is silent over an empty population: with no
// title on both sides `findDrift` compares no pair and the case passes on the summaries
// alone. This pins the population this repository's own guide contributes, so removing
// every `@example` title reddens the suite instead of quietly retiring half the gate.
// The failure names both title sets, because a pin reporting only its own emptiness
// leaves the reader to work out which side dropped the title.
it('pairs at least one example title across the guide and the source', () => {
	const guide = createGuide(requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`))
	const source = createSource({ files, module: own.source })
	const declared = source
		.examples()
		.map((example) => example.title)
		.filter((title) => title !== undefined)
	const titled = new Set(declared)
	const headings: string[] = []
	const paired: string[] = []
	for (const fence of guide.fences()) {
		if (fence.title === undefined) continue
		headings.push(fence.title)
		if (titled.has(fence.title)) paired.push(fence.title)
	}
	const unpaired =
		paired.length > 0
			? []
			: [
					`${GUIDE_SPEC} pairs: guide ${JSON.stringify(headings)} source ${JSON.stringify(declared)}`,
				]
	expect(unpaired).toEqual([])
})

// The README's pitch and the guide's tagline are one text, each read as the blockquote
// under its file's H1. `README.md` is outside the concept index, so the reader is
// applied to it directly rather than through a manifest row. Each side is guarded
// against `undefined` first, so a file that lost its blockquote reports that rather
// than reporting two absences as agreement.
it('opens the README with the guide tagline', () => {
	const pitch = createGuide(requireValue(files['README.md'], 'Missing file: README.md')).tagline()
	const tagline = createGuide(
		requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`),
	).tagline()

	expect(pitch).not.toBeUndefined()
	expect(tagline).not.toBeUndefined()
	expect(pitch).toBe(tagline)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface).map((method) => method.name)
			const documented = group.methods.map((method) => method.name)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, documented)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(documented, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface
							? []
							: findMissing(
									source.methods(entity).map((method) => method.name),
									documented,
								)
					expect(extra).toEqual([])
				})
			})
		}

		// The equality gate: a `Summary` cell against its export's description paragraph, a
		// titled fence against the `@example` of that title. `findDrift` owns the comparison
		// and names both sides; converge the two sides with `npm run docs`, never by
		// weakening this assertion. `findDrift` pairs an example only where a title is
		// present on both sides, so an untitled `@example` block is outside this case. Each
		// collected line is the spec, the key, and each side's text or `absent` — the same
		// worklist `npm run docs` prints, so a failure here is read the way that command's
		// output is.
		it('keeps every compared summary and example equal to its source', () => {
			const disagreeing: string[] = []
			for (const drift of findDrift(guide, source)) {
				const left = drift.guide === undefined ? 'absent' : JSON.stringify(drift.guide)
				const right = drift.source === undefined ? 'absent' : JSON.stringify(drift.source)
				disagreeing.push(`${entry.spec} ${drift.key}: guide ${left} source ${right}`)
			}
			expect(disagreeing).toEqual([])
		})

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(
				findUnexampled(
					names,
					fences,
					source.examples().map((example) => example.name),
				),
			).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			const documented = group.methods.map((method) => method.name)
			const examples =
				entity === group.interface
					? source.examples(group.interface).map((example) => example.name)
					: source
							.examples(group.interface)
							.map((example) => example.name)
							.concat(source.examples(entity).map((example) => example.name))
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					expect(findUnexampled(documented, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// Each case below transcribes one flagship fence from `guides/msg.md` and asserts the value
// its comments claim. A fence describing a value loosely — "a UTC date string", "a standalone
// CFB binary" — is asserted as the property the description names.

const EML_SOURCE =
	'Subject: Hello\r\nFrom: sender@example.dev\r\nTo: reader@example.dev\r\n\r\nBody text'

describe('flagship fences', () => {
	it('narrows the Surface fence Result before touching the parsed chain', () => {
		const bytes = new TextEncoder().encode(EML_SOURCE)
		const result = createMSG({ bytes, name: 'message.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.chain.format).toBe('eml')
		expect(result.value.chain.messages[0]?.text).toBe('Body text')
	})

	it('dispatches the Errors fence on the code and reads the context back', () => {
		let caught: unknown
		try {
			throw new MSGError('MALFORMED', 'bad input', { offset: 8 })
		} catch (error) {
			caught = error
		}

		expect(isMSGError(caught)).toBe(true)
		expect(isMSGError(caught) && caught.code === 'MALFORMED').toBe(true)
		expect(isMSGError(caught) ? caught.context : undefined).toStrictEqual({ offset: 8 })
		// Presence guard beside the executed assertion above. The transcription constructs the
		// error with its own arguments, so a fence that stopped passing the context would leave
		// the assertion green while the documented call logged `undefined`.
		expect(requireValue(files['guides/msg.md'], 'Missing file: guides/msg.md')).toContain(
			"new MSGError('MALFORMED', 'bad input', { offset: 8 })",
		)
	})

	it('returns the values the Helpers fence annotates', () => {
		expect(truncateAtNull('abc\0def')).toBe('abc')
		expect(toHexLower(255, 4)).toBe('00ff')
		expect(roundUpToMultiple(10, 8)).toBe(16)
		expect(computeSectors(100, 64)).toBe(2)
		expect(compareCFBName('a', 'b')).toBeLessThan(0)
		expect(isMSGFile(new DataView(new Uint8Array(8).buffer))).toBe(false)
		expect(detectFormat('message.eml', undefined)).toBe('eml')
		expect(isSuccess(success(1))).toBe(true)
		expect(isFailure(failure(new Error()))).toBe(true)
		expect(decodeLatin1(new Uint8Array([65]))).toBe('A')
		expect(decodeWindows1252(new Uint8Array([65]))).toBe('A')
		expect(resolveEncoding('utf-8')).toBe('utf-8')
		expect(formatEmailAddress('A', 'a@x.dev')).toBe('A <a@x.dev>')
		expect(inferExtension('image/png')).toBe('.png')
		expect(decodeMIMEEncoding('aGk=', 'base64')).toStrictEqual(new Uint8Array([104, 105]))
		expect(decodeMIMEText('aGk=', 'base64', 'utf-8')).toBe('hi')
		expect(encodeUTF8('hi')).toStrictEqual(new Uint8Array([104, 105]))
		expect(decodeUTF8(new Uint8Array([65]))).toBe('A')
	})

	it('reads the Helpers fence trailing block, whose values the comments describe', () => {
		const view = new DataView(new Uint8Array([0x48, 0x00, 0x69, 0x00]).buffer)

		expect(readUTF16String(view, 0, 2)).toBe('Hi')
		expect(fileTimeToUTCString(0, 0)).toBe(new Date(Date.UTC(1601, 0, 1)).toUTCString())
		expect(readMicrosoftUUID(new Uint8Array(16), 0)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
		)
	})

	it('burns the Shapers fence entry list into bytes the magic check accepts', () => {
		// The fence writes the exported category rather than a bare 5, so this pins the two
		// together: a change to the constant reddens here instead of leaving the fence stale.
		expect(MSG_CATEGORY_ROOT).toBe(5)

		const entries: readonly MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, length: 0 },
		]
		const burned = burnCFB(entries)

		expect(burned).toBeInstanceOf(Uint8Array)
		expect(isMSGFile(new DataView(burned.buffer, burned.byteOffset, burned.byteLength))).toBe(true)
	})

	it('projects the Shapers fence MIME tree and MSG field tree into the documented messages', () => {
		const part = parseMIMEPart('Subject: Hi\n\nBody text')

		expect(extractMessage(part)).toStrictEqual({
			from: '',
			to: [],
			cc: [],
			subject: 'Hi',
			date: undefined,
			text: 'Body text',
			html: '',
			attachments: [],
		})

		const fields: MSGFieldData = { category: 'msg', subject: 'Hi' }
		const projected = extractMessageFromMSG({
			parse: () => fields,
			attachment: (index: number): MSGAttachment => ({
				name: `a${index}`,
				bytes: new Uint8Array(0),
			}),
		})

		expect(isEmailMessage(projected)).toBe(true)
		expect(projected.subject).toBe('Hi')
	})

	it('parses the Parsers fence text into the documented tree', () => {
		const part = parseMIMEPart('Subject: Hi\n\nBody text')

		expect(part.body).toBe('Body text')
		expect(part.parts).toStrictEqual([])
		expect(part.headers.get('subject')?.value).toBe('Hi')
	})

	it('answers true for every Validators fence value', () => {
		expect(isRecord({})).toBe(true)
		expect(isEmailFormat('eml')).toBe(true)
		expect(
			isEmailAttachment({ name: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array() }),
		).toBe(true)
		expect(
			isEmailMessage({
				from: '',
				to: [],
				cc: [],
				subject: '',
				date: undefined,
				text: '',
				html: '',
				attachments: [],
			}),
		).toBe(true)
		expect(isEmailChain({ format: 'eml', messages: [] })).toBe(true)
	})

	it('exposes what the MSG fence reads off a parsed instance', () => {
		const bytes = new TextEncoder().encode(EML_SOURCE)
		const msg = new MSG({ bytes, name: 'message.eml' })

		expect(msg.options).toStrictEqual({})
		expect(msg.chain.format).toBe('eml')
		expect(msg.chain.messages[0]?.text).toBe('Body text')
		expect(msg.fields).toBeUndefined()
	})

	it('reaches the Factories and Methods fences through a real .msg file', () => {
		const result = createMSG(readFixture('test.msg'))

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const msg = result.value
		expect(msg.chain.format).toBe('msg')

		const first = msg.attachment(0)
		expect(typeof first.name).toBe('string')
		expect(first.bytes).toBeInstanceOf(Uint8Array)

		const rebuilt = msg.burn()
		expect(rebuilt).toBeInstanceOf(Uint8Array)
		expect(isMSGFile(new DataView(rebuilt.buffer, rebuilt.byteOffset, rebuilt.byteLength))).toBe(
			true,
		)
	})
})
