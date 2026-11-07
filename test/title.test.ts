import { expect, test } from 'bun:test';

import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import { titleToSend, type SessionRecord } from '../src/session.ts';

const record: SessionRecord = { actor: 'a', session_id: 's', started: true, mode: 'default', model: null, effort: null };
const info = (customTitle?: string) => ({ sessionId: 's', summary: 'Fix the login bug please', lastModified: 0, customTitle }) as SDKSessionInfo;

test("a pending title takes Claude Code's once it has one", () => {
	expect(titleToSend({ ...record, titled: 'pending' }, info('Fix login redirect'))).toBe('Fix login redirect');
});

test("nothing is said before Claude Code has a title, nor its first prompt", () => {
	expect(titleToSend({ ...record, titled: 'pending' }, info())).toBeNull();
	expect(titleToSend({ ...record, titled: 'pending' }, info('  '))).toBeNull();
	expect(titleToSend({ ...record, titled: 'pending' }, undefined)).toBeNull();
});

test('the same title is said once, and a new one again', () => {
	const said = { ...record, titled: 'pending' as const, title: 'Fix login redirect' };
	expect(titleToSend(said, info('Fix login redirect'))).toBeNull();
	expect(titleToSend(said, info('Renamed'))).toBe('Renamed');
});

test('a given title is never replaced, nor one of a session from before titles', () => {
	expect(titleToSend({ ...record, titled: 'given', title: 'Mine' }, info('Fix login redirect'))).toBeNull();
	expect(titleToSend({ ...record, titled: 'given' }, info('Fix login redirect'))).toBeNull();
	expect(titleToSend(record, info('Fix login redirect'))).toBeNull();
});
