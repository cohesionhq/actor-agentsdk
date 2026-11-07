import { expect, test } from 'bun:test';

import { session } from './fake_session.ts';

const uses = (...tools: [id: string, name: string, input: Record<string, unknown>][]) => ({
	type: 'assistant',
	parent_tool_use_id: null,
	message: { content: tools.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) },
});
const results = (...ids: [id: string, error?: boolean][]) => ({
	type: 'user',
	parent_tool_use_id: null,
	message: { content: ids.map(([id, error]) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: error ?? false })) },
});

test('each tool ends by its message id as its result comes, in whatever order, failed or not', async () => {
	const { handle, ended, idOf } = session();
	await handle(uses(['a', 'Read', { file_path: '/src/a.ts' }], ['b', 'Read', { file_path: '/src/b.ts' }], ['c', 'Grep', { pattern: 'x' }]));
	expect(ended()).toEqual([]);
	await handle(results(['c']));
	await handle(results(['a', true], ['b']));
	expect(ended()).toEqual([idOf('x'), idOf('a.ts'), idOf('b.ts')]);
	// A result heard twice ends nothing more.
	await handle(results(['a']));
	expect(ended()).toHaveLength(3);
});

test('a tool whose message was refused, or a subagent\'s, is not ended', async () => {
	const { handle, ended } = session((report) => report.kind === 'message' && report.content.kind === 'toolUse');
	await handle(uses(['a', 'Read', { file_path: '/src/a.ts' }]));
	await handle(results(['a']));
	await handle({ ...results(['sub']), parent_tool_use_id: 'a' });
	expect(ended()).toEqual([]);
});

test('a held tool ends once it is shown with its result; one shown again with images ends both', async () => {
	const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
	const { handle, ended, sent } = session();
	await handle(uses(['m', 'mcp__x__shot', { name: 'page' }], ['r', 'Bash', { command: 'ls' }]));
	await handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: image }] } });
	await handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'm', content: image }] } });
	const toolUses = sent.flatMap((report, index) => (report.kind === 'message' && report.content.kind === 'toolUse' ? [index + 1] : []));
	// Bash at once, Bash again with its images, then the held one.
	expect(toolUses).toHaveLength(3);
	expect(ended()).toEqual(toolUses);
});

test('a tool whose result never came is not ended, and a held one is still shown', async () => {
	const { handle, ended, messages } = session();
	await handle(uses(['m', 'mcp__x__slow', { name: 'page' }], ['b', 'Bash', { command: 'sleep 9' }]));
	await handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] });
	expect(ended()).toEqual([]);
	expect(messages().filter((report) => report.content.kind === 'toolUse')).toHaveLength(2);
});

test('every tool use carries its category, an MCP tool its readable name, even when shown again with images', async () => {
	const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
	const { handle, messages, ended, idOf } = session();
	await handle(uses(['m', 'mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }], ['b', 'Bash', { command: 'ls' }], ['e', 'Edit', { file_path: '/src/a.ts' }]));
	await handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: image }] } });
	await handle(results(['m'], ['e']));
	const shown = messages().flatMap((report) => (report.content.kind === 'toolUse' ? [[report.content.tool, report.content.category]] : []));
	expect(shown).toEqual([
		['Bash', 'command'],
		['Edit', 'edit'],
		['Bash', 'command'],
		['Gmail: search threads', 'other'],
	]);
	// The tool is still found by its id, under Claude Code's own name.
	expect(ended()).toContain(idOf('invoice'));
});

test('words said while requests wait pass them over: Claude Code hears them as the answer, and goes on', async () => {
	const { session: it, prompt, sent } = session();
	const question = { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] };
	const asked = prompt('AskUserQuestion', question);
	const permitted = prompt('Bash', { command: 'ls' });
	// Both wait on the user before they speak.
	while ((it as unknown as { waiting: Map<number, unknown> }).waiting.size < 2) await Bun.sleep(0);
	it.hear({ kind: 'text', text: 'Neither, use C' });
	for (const settled of await Promise.all([asked, permitted])) {
		expect(settled).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Neither, use C') });
		expect(settled).not.toHaveProperty('interrupt', true);
	}
	expect(sent.at(-1)).toEqual({ kind: 'status', status: 'working' });
});

const thinks = (...blocks: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: blocks } });

test('thinking is its own transcript entry, in order, ended at once by its message id', async () => {
	const { handle, sent, ended, messages } = session();
	await handle(thinks({ type: 'thinking', thinking: 'Weighing **it** up.', signature: 'x' }, { type: 'text', text: 'Done.' }));
	expect(messages().map((report) => report.content)).toEqual([
		{ kind: 'thinking', text: 'Weighing **it** up.', ended_at: null },
		{ kind: 'text', text: 'Done.' },
	]);
	const id = sent.findIndex((report) => report.kind === 'message' && report.content.kind === 'thinking') + 1;
	expect(ended()).toEqual([id]);
	// Ended before the words after it are said.
	expect(sent.findIndex((report) => report.kind === 'end')).toBeLessThan(sent.findIndex((report) => report.kind === 'message' && report.content.kind === 'text'));
});

test('thinking with no text, redacted thinking and a subagent\'s thinking are not shown', async () => {
	const { handle, messages, ended } = session();
	await handle(thinks({ type: 'thinking', thinking: '', signature: 'x' }, { type: 'thinking', thinking: ' \n', signature: 'x' }, { type: 'redacted_thinking', data: 'x' }));
	await handle({ ...thinks({ type: 'thinking', thinking: 'A subagent\'s.', signature: 'x' }), parent_tool_use_id: 'a' });
	expect(messages()).toEqual([]);
	expect(ended()).toEqual([]);
});

test('thinking whose message was refused is not ended, and what follows is still said', async () => {
	const { handle, messages, ended } = session((report) => report.kind === 'message' && report.content.kind === 'thinking');
	await handle(thinks({ type: 'thinking', thinking: 'Hmm.', signature: 'x' }, { type: 'text', text: 'Done.' }));
	expect(ended()).toEqual([]);
	expect(messages().at(-1)?.content).toEqual({ kind: 'text', text: 'Done.' });
});
