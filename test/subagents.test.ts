import { expect, test } from 'bun:test';

import { session } from './fake_session.ts';

type Sent = { kind: string; subagent?: string; [field: string]: unknown };

const agentUse = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Map the db layer', subagent_type: 'Explore', prompt: 'go' } }] } };
const started = (extra: Record<string, unknown> = {}) => ({
	type: 'system',
	subtype: 'task_started',
	task_id: 'a1',
	tool_use_id: 'tu1',
	description: 'Map the db layer',
	subagent_type: 'Explore',
	task_type: 'local_agent',
	is_backgrounded: true,
	...extra,
});
const step = (agent: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
	type: 'assistant',
	parent_tool_use_id: 'tu1',
	agent_id: agent,
	message: { model: 'claude-haiku', content },
	...extra,
});
const sentOf = (all: unknown[]) => all as Sent[];

test('a started subagent is launched with its tool use\'s message, kind, background and no parent', async () => {
	const { handle, sent } = session();
	await handle(agentUse);
	await handle(started());
	const launch = sentOf(sent).find((report) => report.kind === 'launch');
	expect(launch).toMatchObject({
		subagent: 'a1',
		title: 'Map the db layer',
		parent: null,
		message_id: sentOf(sent).findIndex((report) => report.kind === 'message') + 1,
		agent_type: 'Explore',
		background: true,
	});
	// Before anything else about it.
	expect(sentOf(sent).findIndex((report) => report.subagent === 'a1')).toBe(sentOf(sent).findIndex((report) => report.kind === 'launch'));
});

test('a subagent\'s steps are its own transcript, addressed to it, and leave the session\'s status alone', async () => {
	const { handle, sent, ended } = session();
	await handle(agentUse);
	await handle(started());
	const before = sentOf(sent).filter((report) => report.subagent === undefined).length;
	await handle(step('a1', [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/src/a.ts' } }]));
	await handle({ type: 'user', parent_tool_use_id: 'tu1', agent_id: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok' }] } });
	const own = sentOf(sent).filter((report) => report.subagent === 'a1' && report.kind === 'message').map((report) => (report.content as { kind: string }).kind);
	expect(own).toEqual(['thinking', 'text', 'toolUse']);
	// The thinking and the read both end, in the child's transcript.
	const ends = sentOf(sent).filter((report) => report.kind === 'end');
	expect(ends.length).toBe(2);
	expect(ends.every((report) => report.subagent === 'a1')).toBe(true);
	expect(ended()).toHaveLength(2);
	// The session's own status and progress were not touched by the child.
	expect(sentOf(sent).filter((report) => report.subagent === undefined)).toHaveLength(before);
});

test('the model its first step shows is said by launching again', async () => {
	const { handle, sent } = session();
	await handle(agentUse);
	await handle(started());
	await handle(step('a1', [{ type: 'text', text: 'hi' }]));
	await handle(step('a1', [{ type: 'text', text: 'again' }]));
	const launches = sentOf(sent).filter((report) => report.kind === 'launch');
	expect(launches.map((report) => report.model)).toEqual([null, 'claude-haiku']);
});

test('a subagent launched from another\'s tool use goes under it, naming that tool use\'s message', async () => {
	const { handle, sent } = session();
	await handle(agentUse);
	await handle(started());
	await handle(step('a1', [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Dig deeper', subagent_type: 'Explore' } }]));
	await handle(started({ task_id: 'b2', tool_use_id: 'tu2', description: 'Dig deeper', parent_task_id: 'a1', is_backgrounded: false }));
	const launches = sentOf(sent).filter((report) => report.kind === 'launch' && report.subagent === 'b2');
	const tool = sentOf(sent).findIndex((report) => report.subagent === 'a1' && report.kind === 'message' && (report.content as { kind: string }).kind === 'toolUse') + 1;
	expect(launches[0]).toMatchObject({ parent: 'a1', message_id: tool, background: false });
});

test('shells and other tasks are not subagents', async () => {
	const { handle, sent } = session();
	await handle(started({ task_type: 'local_bash' }));
	expect(sentOf(sent).filter((report) => report.kind === 'launch')).toEqual([]);
});

test('a subagent\'s statuses: done is idle, a killed task is idle, a failed one failed', async () => {
	const { handle, sent } = session();
	await handle(started());
	await handle(started({ task_id: 'k', tool_use_id: 'tk' }));
	await handle(started({ task_id: 'f', tool_use_id: 'tf' }));
	await handle({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } });
	await handle({ type: 'system', subtype: 'task_updated', task_id: 'k', patch: { status: 'killed' } });
	await handle({ type: 'system', subtype: 'task_updated', task_id: 'f', patch: { status: 'failed', error: 'boom' } });
	const statuses = sentOf(sent).filter((report) => report.kind === 'status').map((report) => [report.subagent, report.status]);
	expect(statuses).toEqual([['a1', 'idle'], ['k', 'idle'], ['f', 'failed']]);
	expect(sentOf(sent).some((report) => report.subagent === 'f' && report.kind === 'message')).toBe(true);
});

test('a task notification settles the subagent', async () => {
	const { handle, sent } = session();
	await handle(started());
	await handle({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'tu1', status: 'stopped', summary: '', output_file: '' });
	expect(sentOf(sent).filter((report) => report.kind === 'status')).toEqual([{ kind: 'status', status: 'idle', subagent: 'a1' }]);
});

test('a foreground subagent is done when its tool use gets its result', async () => {
	const { handle, sent } = session();
	await handle(agentUse);
	await handle(started({ is_backgrounded: false }));
	await handle({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] } });
	expect(sentOf(sent).filter((report) => report.kind === 'status' && report.subagent)).toEqual([{ kind: 'status', status: 'idle', subagent: 'a1' }]);
});

test('a subagent\'s permission request goes in its transcript, waits there, and its answer reaches it', async () => {
	const { handle, session: it, sent } = session();
	const said: string[] = [];
	it.say = (text) => void said.push(text);
	await handle(started());
	const options = { signal: new AbortController().signal, agentID: 'a1', toolUseID: 'x' };
	const asked = (it as unknown as { prompt: (n: string, i: unknown, o: unknown) => Promise<unknown> }).prompt('Bash', { command: 'ls' }, options);
	await Bun.sleep(0);
	const request = sentOf(sent).findIndex((report) => report.kind === 'message' && report.subagent === 'a1') + 1;
	expect(request).toBeGreaterThan(0);
	expect(sentOf(sent).filter((report) => report.kind === 'status')).toEqual([{ kind: 'status', status: 'needsAttention', subagent: 'a1' }]);
	// Answered with no subagent, it is not the child's: Claude hears words.
	it.hear({ kind: 'permission', request_id: request, decision: 'allow' } as never, [], undefined);
	await Bun.sleep(0);
	expect(said).toHaveLength(1);
	it.hear({ kind: 'permission', request_id: request, decision: 'allow' } as never, [], 'a1');
	expect(await asked).toMatchObject({ behavior: 'allow' });
	await Bun.sleep(0);
	expect(sentOf(sent).filter((report) => report.kind === 'status').at(-1)).toEqual({ kind: 'status', status: 'working', subagent: 'a1' });
});

test('words to the session do not answer a subagent\'s request', async () => {
	const { handle, session: it, sent } = session();
	const said: string[] = [];
	it.say = (text) => void said.push(text);
	await handle(started());
	const options = { signal: new AbortController().signal, agentID: 'a1', toolUseID: 'x' };
	let answered = false;
	void (it as unknown as { prompt: (n: string, i: unknown, o: unknown) => Promise<unknown> }).prompt('Bash', { command: 'ls' }, options).then(() => (answered = true));
	await Bun.sleep(0);
	// Words to the session go to the session, not the child's request.
	it.hear({ kind: 'text', text: 'hello' }, []);
	await Bun.sleep(0);
	expect(said).toEqual(['hello']);
	expect(answered).toBe(false);
	// Words in the child's transcript answer its request.
	it.hear({ kind: 'text', text: 'no' }, [], 'a1');
	await Bun.sleep(0);
	expect(answered).toBe(true);
	expect(sentOf(sent).length).toBeGreaterThan(0);
});

test('a reconnect launches every subagent again, parents first, with its status', async () => {
	const { handle, sent, session: it } = session();
	await handle(agentUse);
	await handle(started());
	await handle(step('a1', [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Dig' } }]));
	await handle(started({ task_id: 'b2', tool_use_id: 'tu2', description: 'Dig', parent_task_id: 'a1' }));
	await handle({ type: 'system', subtype: 'task_updated', task_id: 'b2', patch: { status: 'completed' } });
	const again: Sent[] = [];
	await it.resync(async (report, subagent) => void again.push({ ...report, ...(subagent ? { subagent } : {}) } as Sent));
	expect(again.filter((report) => report.subagent).map((report) => [report.kind, report.subagent, report.status ?? report.parent])).toEqual([
		['launch', 'a1', null],
		['status', 'a1', 'working'],
		['launch', 'b2', 'a1'],
		['status', 'b2', 'idle'],
	]);
});

test('stopping the session leaves its working subagents idle', async () => {
	const { handle, sent, session: it } = session();
	await handle(started());
	await it.stop();
	expect(sentOf(sent).filter((report) => report.kind === 'status')).toEqual([{ kind: 'status', status: 'idle', subagent: 'a1' }]);
});
