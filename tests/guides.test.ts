// The guides-parity gate: `@orkestrel/guide`'s checks run against this repository's own
// `guides/README.md` manifest, and every flagship fence in `guides/msg.md` is transcribed
// here and asserted against what its comments claim. Name resolution is not a behavioural
// proof, so a fence documenting a value the code contradicts is exactly what the
// transcriptions catch. Change a fence, change its transcription.
//
// `FENCE_LANGUAGES`, `EXAMPLE_LANGUAGE`, `MODULES`, `INTERNAL`, and `ROOT_FILES` below are
// this package's own, and are the only part a sibling package changes.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
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
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/msg': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

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

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
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
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
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
