// What the kit's `SessionHost` needs to know of Claude Code: the record an
// actor session keeps, the modes it can run in, and how to run one.

import { randomUUID } from 'node:crypto';

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEngine, SessionStore } from 'cohesion-agent-kit';

import { MODES } from './offers.ts';
import { ActorSession, type SessionRecord } from './session.ts';
import { displayName } from './translate.ts';
import type { Usage } from './usage.ts';

export function claudeCodeEngine(store: SessionStore<SessionRecord>, usage: Usage, log: (message: string) => void): SessionEngine<SessionRecord> {
	return {
		speaker: 'Claude',
		agentSession: 'an Agent SDK session',
		toolName: displayName,
		start: (actor, call) => ({
			...fresh(actor.identifier, call.mode, call.model, call.effort),
			...(call.title ? { titled: 'given' as const, title: call.title } : { titled: 'pending' as const }),
		}),
		recover: (actor, held) => ({
			...fresh(actor.identifier, held.mode, held.model, held.effort),
			// Claude Code's title would describe the transcript it is handed, not the session.
			titled: 'given',
		}),
		checkMode: (_, identifier) => {
			const offered = MODES.find((mode) => mode.identifier === identifier);
			if (!offered) throw new Error(`Agent SDK has no mode ${identifier}.`);
			return offered.identifier;
		},
		// The host hands this what `checkMode` returned.
		withMode: (record, mode: PermissionMode) => ({ ...record, mode }),
		open: (id, record, actor, client) => new ActorSession(id, record, { client, store, cwd: actor.directory, usage, log }),
	};
}

/** A record for a new Claude Code session, in the mode cohesiond names or else the default. */
function fresh(actor: string, mode: string | null, model: string | null, effort: string | null): Omit<SessionRecord, 'titled' | 'title'> {
	return {
		actor,
		session_id: randomUUID(),
		started: false,
		mode: MODES.find(({ identifier }) => identifier === mode)?.identifier ?? MODES[0]!.identifier,
		model,
		effort,
	};
}
