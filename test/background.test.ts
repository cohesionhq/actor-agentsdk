import { expect, jest, test } from 'bun:test';

import { keepsWorking } from '../src/session.ts';
import { session } from './fake_session.ts';

const step = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const tool = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } };
const done = { type: 'result', subtype: 'success', is_error: false, modelUsage: {} };
const background = (...tasks: [id: string, type: string][]) => ({
	type: 'system',
	subtype: 'background_tasks_changed',
	tasks: tasks.map(([task_id, task_type]) => ({ task_id, task_type, description: '' })),
});
const init = { type: 'system', subtype: 'init' };

/** A stretch the session runs, so its timers act on it, with what was asked of its process. */
function running(it: unknown) {
	const asked: string[] = [];
	const stretch = {
		linger: null,
		closed: true,
		input: { close() {} },
		query: { stopTask: async (id: string) => void asked.push(`stop ${id}`), interrupt: async () => void asked.push('interrupt') },
	};
	(it as { stretch: unknown }).stretch = stretch;
	return { stretch, asked };
}

const statuses = (sent: { kind: string; status?: string }[]) => sent.flatMap((report) => (report.kind === 'status' ? [report.status] : []));
const progresses = (sent: { kind: string; progress?: string | null }[]) => sent.flatMap((report) => (report.kind === 'progress' ? [report.progress] : []));

test('a turn that ends with background agents running stays working until Claude Code takes their results up and ends', async () => {
	const { session: it, handle, sent } = session();
	const { stretch } = running(it);
	await handle(tool, stretch);
	await handle(background(['a', 'local_agent'], ['b', 'local_agent']), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working']);
	expect(progresses(sent).at(-1)).toBe('Waiting on 2 background agents');
	await handle(background(['b', 'local_agent']), stretch);
	expect(progresses(sent).at(-1)).toBe('Waiting on a background agent');
	await handle(background(), stretch);
	// Claude Code's own turn on their results, then its end.
	await handle(init, stretch);
	await handle(step('The explorers are back'), stretch);
	expect(progresses(sent).at(-1)).toBeNull();
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working', 'idle']);
	expect(it.status).toBe('idle');
});

test('a turn Claude Code takes up while other agents still run stays working too', async () => {
	const { session: it, handle, sent } = session();
	const { stretch } = running(it);
	await handle(tool, stretch);
	await handle(background(['a', 'local_agent'], ['b', 'local_workflow']), stretch);
	await handle(done, stretch);
	await handle(background(['b', 'local_workflow']), stretch);
	await handle(init, stretch);
	await handle(step('One is back'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working']);
	await handle(background(), stretch);
	await handle(init, stretch);
	await handle(step('All back'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working', 'idle']);
});

test('background shells, monitors and ambient tasks don\'t keep the turn going', async () => {
	expect(keepsWorking({ task_type: 'local_agent' })).toBe(true);
	expect(keepsWorking({ task_type: 'local_workflow' })).toBe(true);
	expect(keepsWorking({ task_type: 'local_agent', ambient: true })).toBe(false);
	expect(keepsWorking({ task_type: 'local_bash' })).toBe(false);
	const { session: it, handle, sent } = session();
	const { stretch } = running(it);
	await handle(tool, stretch);
	await handle(background(['s', 'local_bash']), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working', 'idle']);
});

test('background work that ends with no turn to follow leaves the session idle soon after', async () => {
	jest.useFakeTimers();
	try {
		const { session: it, handle, sent } = session();
		const { stretch } = running(it);
		await handle(tool, stretch);
		await handle(background(['a', 'local_agent']), stretch);
		await handle(done, stretch);
		await handle(background(), stretch);
		expect(statuses(sent)).toEqual(['working']);
		jest.advanceTimersByTime(10_000);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(statuses(sent)).toEqual(['working', 'idle']);
	} finally {
		jest.useRealTimers();
	}
});

test('stopping a session waiting on background agents stops them, with no turn to interrupt', async () => {
	const { session: it, handle } = session();
	const { stretch, asked } = running(it);
	await handle(tool, stretch);
	await handle(background(['a', 'local_agent'], ['s', 'local_bash']), stretch);
	await handle(done, stretch);
	await it.stop();
	expect(asked).toEqual(['stop a']);
	expect(it.status).toBe('idle');
});

/** A session whose `stretch` takes what is said without a real process. */
function listening(it: unknown) {
	const { stretch } = running(it);
	(stretch.input as unknown as { push(): void }).push = () => {};
	return stretch;
}

test('a self-started text-only turn reports no status change', async () => {
	const { session: it, handle, sent, messages } = session();
	const { stretch } = running(it);
	await handle(init, stretch);
	await handle(step('Still waiting on the monitor'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual([]);
	expect(it.status).toBe('idle');
	expect(messages()).toHaveLength(1);
});

test('a self-started turn that uses a tool reports working and then idle', async () => {
	const { session: it, handle, sent } = session();
	const { stretch } = running(it);
	await handle(init, stretch);
	await handle(step('The build failed, looking into it'), stretch);
	expect(statuses(sent)).toEqual([]);
	await handle(tool, stretch);
	expect(statuses(sent)).toEqual(['working']);
	await handle(step('Fixed'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['working', 'idle']);
});

test('a turn started by a wake still reports working at once', async () => {
	const { session: it, handle, sent } = session();
	const stretch = listening(it);
	// On an idle session cohesiond sets it working itself; the client just knows at once.
	it.say('Your dependency finished');
	expect(it.status).toBe('working');
	await handle(step('On it'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['idle']);
	await handle(tool, stretch);
	expect(statuses(sent)).toEqual(['idle', 'working']);
	// One that lands during a turn begins after that turn's idle: its first words report working, tool or no tool.
	it.say('Your other dependency finished');
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['idle', 'working', 'idle']);
	await handle(step('On that too'), stretch);
	expect(statuses(sent)).toEqual(['idle', 'working', 'idle', 'working']);
});

test('words said during a self-started turn make the next turn theirs, reported at once', async () => {
	const { session: it, handle, sent } = session();
	const stretch = listening(it);
	await handle(step('Still waiting on the monitor'), stretch);
	it.say('Do the next thing');
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['idle']);
	await handle(step('Doing it'), stretch);
	expect(statuses(sent)).toEqual(['idle', 'working']);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['idle', 'working', 'idle']);
});

test('a self-started text-only turn leaves a failed session failed', async () => {
	const { session: it, handle, sent } = session();
	const { stretch } = running(it);
	await handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], modelUsage: {} }, stretch);
	expect(statuses(sent)).toEqual(['failed']);
	await handle(step('The shell exited'), stretch);
	await handle(done, stretch);
	expect(statuses(sent)).toEqual(['failed']);
});

test('a background agent\'s tool use stays open until its task_notification', async () => {
	const { session: it, handle, ended, sent } = session();
	/** The ids of the tool use messages, in order. */
	const uses = () => sent.flatMap((r, i) => (r.kind === 'message' && r.content.kind === 'toolUse' ? [i + 1] : []));
	const { stretch } = running(it);
	const agent = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'explore' } }] } };
	await handle(agent, stretch);
	await handle(
		{ type: 'user', parent_tool_use_id: null, tool_use_result: { status: 'async_launched', agentId: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'Async agent launched' }] } },
		stretch,
	);
	expect(ended()).toEqual([]);
	await handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'other', status: 'completed' }, stretch);
	expect(ended()).toEqual([]);
	await handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'ag', status: 'completed' }, stretch);
	expect(ended()).toEqual(uses());
	await handle({ type: 'system', subtype: 'task_notification', tool_use_id: 'ag', status: 'completed' }, stretch);
	expect(ended()).toEqual(uses());
});

test('a foreground agent ends with its result, and a launched one ends when the process does', async () => {
	const { session: it, handle, ended, sent } = session();
	/** The ids of the tool use messages, in order. */
	const uses = () => sent.flatMap((r, i) => (r.kind === 'message' && r.content.kind === 'toolUse' ? [i + 1] : []));
	const { stretch } = running(it);
	const use = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description: id } }] } });
	const result = (id: string, tool_use_result?: unknown) => ({ type: 'user', parent_tool_use_id: null, tool_use_result, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
	await handle(use('fg'), stretch);
	await handle(result('fg', { status: 'completed' }), stretch);
	expect(ended()).toEqual(uses());
	await handle(use('bg'), stretch);
	await handle(result('bg', { status: 'async_launched' }), stretch);
	expect(ended()).toEqual(uses().slice(0, 1));
	await (it as unknown as { finish(): Promise<void> }).finish();
	expect(ended()).toEqual(uses());
});
