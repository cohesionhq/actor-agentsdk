import { expect, test } from 'bun:test';

import type { CanUseTool, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { category, displayName, progress, request, result, toolUse } from '../src/translate.ts';

type Options = Parameters<CanUseTool>[2];
const options = (extra: Partial<Options> = {}): Options => ({ signal: new AbortController().signal, toolUseID: 't', requestId: 'r', ...extra }) as Options;
const cwd = '/src/project';

test("a question's answers reach Claude Code keyed by question, the user's own words last", () => {
	const input = {
		questions: [
			{ question: 'Which checks?', header: 'Checks', options: [{ label: 'Tests', description: '' }, { label: 'Lint', description: '' }], multiSelect: true },
			{ question: 'Add a test?', header: 'Test', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false },
		],
	};
	const asked = request('AskUserQuestion', input, options(), cwd);
	expect(asked).toMatchObject({ kind: 'question', questions: [{ multi_select: true, allows_other: true }, { multi_select: false }] });
	const answered = result('AskUserQuestion', input, options(), {
		kind: 'answers',
		request_id: 1,
		answers: [{ selected: ['Tests', 'Lint'], other: 'and fmt' }, { selected: [], other: 'Only if quick' }],
	});
	expect(answered).toEqual({
		behavior: 'allow',
		updatedInput: { ...input, answers: { 'Which checks?': 'Tests, Lint, and fmt', 'Add a test?': 'Only if quick' } },
	});
});

test('allowing for the session is offered only with suggestions, and never writes settings', () => {
	const suggestion: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cargo test:*' }], behavior: 'allow', destination: 'localSettings' };
	const input = { command: 'cargo test', description: 'Run the tests' };
	expect(request('Bash', input, options(), cwd)).toMatchObject({ decisions: ['allow', 'deny', 'abort'] });
	expect(request('Bash', input, options({ suggestions: [suggestion], suppressAlwaysAllowRule: true }), cwd)).toMatchObject({ decisions: ['allow', 'deny', 'abort'] });
	expect(request('Bash', input, options({ suggestions: [suggestion] }), cwd)).toMatchObject({
		subject: { kind: 'command', command: 'cargo test', cwd },
		reason: 'Run the tests',
		decisions: ['allow', 'allowForSession', 'deny', 'abort'],
	});
	const allowed = result('Bash', input, options({ suggestions: [suggestion] }), { kind: 'permission', request_id: 1, decision: 'allowForSession' });
	expect(allowed).toMatchObject({ behavior: 'allow', updatedPermissions: [{ ...suggestion, destination: 'session' }] });
});

test('deny lets Claude Code carry on, abort stops the turn', () => {
	const deny = result('Bash', {}, options(), { kind: 'permission', request_id: 1, decision: 'deny', message: 'Not here' });
	const abort = result('Bash', {}, options(), { kind: 'permission', request_id: 1, decision: 'abort' });
	expect(deny).toMatchObject({ behavior: 'deny', interrupt: false });
	expect(abort).toMatchObject({ behavior: 'deny', interrupt: true });
});

test("an approved plan moves the session to Auto; one that isn't is denied with the user's feedback", () => {
	const input = { plan: '1. Fix it.' };
	expect(request('ExitPlanMode', input, options(), cwd)).toEqual({ kind: 'plan', plan: '1. Fix it.' });
	expect(result('ExitPlanMode', input, options(), { kind: 'plan', request_id: 1, approved: true })).toEqual({
		behavior: 'allow',
		updatedInput: input,
		updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
	});
	const denied = result('ExitPlanMode', input, options(), { kind: 'plan', request_id: 1, approved: false, feedback: 'Keep the old API.' });
	expect(denied.behavior).toBe('deny');
	expect(denied.behavior === 'deny' && denied.message).toContain('Keep the old API.');
});

test('a file outside the directory keeps its absolute path; one inside is shown relative', () => {
	expect(request('Write', { file_path: '/src/project/a/b.ts', content: 'x' }, options(), cwd)).toMatchObject({
		subject: { kind: 'fileChange', changes: [{ path: 'a/b.ts', change: 'add' }] },
	});
	expect(request('Write', { file_path: '/etc/hosts2', content: 'x' }, options(), cwd)).toMatchObject({
		subject: { changes: [{ path: '/etc/hosts2' }] },
	});
});

test('a command shows as what it does when Claude Code says, and as itself when not', () => {
	const described = { command: 'git status --short', description: 'Show working tree status' };
	expect(toolUse('Bash', described, cwd)).toEqual({ kind: 'toolUse', tool: 'Bash', category: 'command', summary: 'Show working tree status' });
	expect(progress('Bash', described, cwd)).toBe('Show working tree status');
	expect(toolUse('Bash', { command: 'git status --short' }, cwd)).toMatchObject({ summary: 'git status --short' });
	expect(progress('Bash', { command: 'git status --short' }, cwd)).toBe('Running git status --short');
});

test('a skill shows as its name and arguments', () => {
	expect(toolUse('Skill', { skill: 'commit', args: '-m fix' }, cwd)).toEqual({ kind: 'toolUse', tool: 'Skill', category: 'skill', summary: 'commit -m fix' });
	expect(toolUse('Skill', { args: '-m fix', skill: 'commit' }, cwd)).toMatchObject({ summary: 'commit -m fix' });
	expect(toolUse('Skill', { skill: 'commit' }, cwd)).toMatchObject({ summary: 'commit' });
	expect(progress('Skill', { skill: 'commit', args: '-m fix' }, cwd)).toBe('Running skill commit -m fix');
	expect(progress('Skill', {}, cwd)).toBe('Using Skill');
	expect(request('Skill', { skill: 'commit', args: '-m fix' }, options(), cwd)).toMatchObject({
		kind: 'permission',
		subject: { kind: 'tool', name: 'Skill', input: { skill: 'commit', args: '-m fix' } },
	});
});

test('each tool is classified by what it does; MCP tools and unknown names are other', () => {
	const kinds = {
		command: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
		read: ['Read', 'NotebookRead', 'LS'],
		edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
		search: ['Grep', 'Glob'],
		web: ['WebFetch', 'WebSearch'],
		agent: ['Agent', 'Task'],
		skill: ['Skill'],
		other: ['TodoWrite', 'mcp__xcode__run', 'mcp__claude_ai_Gmail__search_threads', 'SomethingNew', 'bash', 'toString', ''],
	};
	for (const [kind, names] of Object.entries(kinds)) {
		for (const name of names) expect([name, category(name)]).toEqual([name, kind as ReturnType<typeof category>]);
	}
	expect(toolUse('Grep', { pattern: 'x' }, cwd)).toEqual({ kind: 'toolUse', tool: 'Grep', category: 'search', summary: 'x' });
	expect(toolUse('mcp__xcode__run', { scheme: 'App' }, cwd)).toEqual({ kind: 'toolUse', tool: 'Xcode: run', category: 'other', summary: 'App' });
});

test('an MCP tool shows as its server and tool in words; other names are left alone', () => {
	expect(displayName('mcp__xcode__run')).toBe('Xcode: run');
	expect(displayName('mcp__claude_ai_Gmail__search_threads')).toBe('Gmail: search threads');
	expect(displayName('mcp__my-server__get-page_title')).toBe('My server: get page title');
	expect(displayName('mcp__a__b__c')).toBe('A: b c');
	expect(displayName('mcp__solo')).toBe('Solo');
	expect(displayName('mcp__solo__')).toBe('Solo');
	expect(displayName('mcp____tool')).toBe('tool');
	expect(displayName('mcp__')).toBe('mcp__');
	expect(displayName('Bash')).toBe('Bash');
	expect(displayName('my_tool')).toBe('my_tool');
	expect(progress('mcp__claude_ai_Gmail__search_threads', {}, cwd)).toBe('Using Gmail: search threads');
	expect(request('mcp__xcode__run', { scheme: 'App' }, options(), cwd)).toMatchObject({ kind: 'permission', subject: { kind: 'tool', name: 'Xcode: run' } });
});
