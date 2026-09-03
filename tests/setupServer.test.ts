import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { captureError } from '@orkestrel/test'
import { FIXTURES_ROOT, readFixture, WORKSPACE_ROOT } from './setupServer.js'

// `tests/setupServer.ts` is the one fixture loader the core suites read binary email
// fixtures through, so each case asserts the contract those suites depend on and derives
// its expectation by a route the module does not share: an absolute path built from the
// workspace root against the module's own join, and a direct `readFileSync` of the same
// file against the loader's copy.

describe('WORKSPACE_ROOT', () => {
	it('names an absolute directory holding this workspace, not the runner working directory', () => {
		expect(isAbsolute(WORKSPACE_ROOT)).toBe(true)
		expect(readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8')).toContain('"@orkestrel/msg"')
	})
})

describe('FIXTURES_ROOT', () => {
	it('resolves under the workspace root rather than relative to the caller', () => {
		expect(FIXTURES_ROOT).toBe(join(WORKSPACE_ROOT, 'tests', 'src', 'core', 'fixtures'))
		expect(readFileSync(join(FIXTURES_ROOT, 'test.msg')).length).toBeGreaterThan(0)
	})
})

describe('readFixture', () => {
	it('returns the fixture bytes the platform reader produces', () => {
		const bytes = readFixture('test.msg')
		const direct = readFileSync(join(FIXTURES_ROOT, 'test.msg'))

		expect(bytes.length).toBe(direct.length)
		expect(Array.from(bytes.subarray(0, 8))).toEqual(Array.from(direct.subarray(0, 8)))
	})

	it('returns bytes it owns, so a caller slicing them cannot reach the read buffer', () => {
		// `readFileSync` returns a Node Buffer, whose own `slice` shares memory. Three
		// suites read the same fixtures, so an aliased slice would let one suite's edit
		// land in another's bytes.
		const bytes = readFixture('test.msg')
		const slice = bytes.slice(0, 8)
		slice[0] = 0x00

		expect(bytes[0]).toBe(0xd0)
		expect(readFixture('test.msg')[0]).toBe(0xd0)
	})

	it('resolves each name against the fixtures directory rather than the caller directory', () => {
		expect(readFixture('attachmentFiles.msg').length).toBeGreaterThan(0)
		expect(readFixture('msgInMsg.msg').length).toBeGreaterThan(0)
	})

	it('propagates the read error for a name the fixtures directory does not hold', () => {
		const thrown = captureError(() => readFixture('absent.msg'))

		expect(thrown).toBeInstanceOf(Error)
		expect(String(thrown)).toContain('absent.msg')
	})
})
