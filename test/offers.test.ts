import { expect, test } from 'bun:test';

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { newestModels } from '../src/offers.ts';

const model = (value: string, resolvedModel?: string): ModelInfo => ({ value, resolvedModel, displayName: value, description: '' });

// As Claude Code lists them: its aliases, then the pinned versions.
const listed = [
	model('default', 'claude-opus-5-5'),
	model('opus', 'claude-opus-5-5'),
	model('fable', 'claude-fable-5-1'),
	model('sonnet', 'claude-sonnet-5-5'),
	model('haiku', 'claude-haiku-5-5'),
	model('claude-opus-5', 'claude-opus-5'),
	model('claude-sonnet-4-6', 'claude-sonnet-4-6'),
];

test('only the aliases are offered, once per model', () => {
	expect(newestModels(listed).map((model) => model.value)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
});

test("every model is offered when Claude Code doesn't say what its aliases resolve to", () => {
	const unresolved = [model('opus'), model('claude-opus-5')];
	expect(newestModels(unresolved)).toEqual(unresolved);
});
