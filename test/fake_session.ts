// An ActorSession reporting to a fake cohesiond, handed Claude Code's messages directly.

import type { SessionStore } from 'cohesion-agent-kit';
import type { ActorSessionReport, ActorUsage, Client } from 'cohesion-ts';

import { ActorSession, type SessionRecord } from '../src/session.ts';
import { Usage } from '../src/usage.ts';

/** An actor session reporting to a fake cohesiond, which refuses what `refuse` says to. */
export function session(refuse: (report: ActorSessionReport) => boolean = () => false) {
	const sent: ActorSessionReport[] = [];
	const client = {
		report: async (_: number, report: ActorSessionReport) => {
			sent.push(report);
			if (refuse(report)) throw new Error('refused');
			return { id: sent.length };
		},
	} as unknown as Client;
	const store = { put() {}, get() {} } as unknown as SessionStore<SessionRecord>;
	const usages: ActorUsage[] = [];
	const usage = new Usage(async (_, said) => void usages.push(said), () => ['a'], () => {});
	const it = new ActorSession(1, { actor: 'a', session_id: 's', started: true, mode: 'default', model: null, effort: null }, { client, store, cwd: '/src', usage, log() {} });
	const handle = (message: unknown, stretch: unknown = {}) => (it as unknown as { handle(m: unknown, s: unknown): Promise<void> }).handle(message, stretch);
	type Prompt = (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
	/** Claude Code's permission prompt for tool `name`, settling with what it is told. */
	const prompt = (name: string, input: Record<string, unknown>) =>
		(it as unknown as { prompt: Prompt }).prompt(name, input, { signal: new AbortController().signal });
	return {
		session: it,
		prompt,
		sent,
		/** The actor's usage as said to cohesiond, in order. */
		usages,
		/** The session's context as said to cohesiond, in order. */
		contexts: () => sent.flatMap((report) => (report.kind === 'context' ? [report.context] : [])),
		handle,
		messages: () => sent.filter((report) => report.kind === 'message'),
		/** The ids of the messages whose tools were ended, in order. */
		ended: () => sent.flatMap((report) => (report.kind === 'end' ?[report.message_id] : [])),
		/** The id the fake gave the `toolUse` message for `summary`, or -1 when none. */
		idOf: (summary: string) =>
			sent.findIndex((report) => report.kind === 'message' && report.content.kind === 'toolUse' && report.content.summary === summary) + 1 || -1,
	};
}
