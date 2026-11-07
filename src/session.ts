// One actor session, run as one Claude Code session: what the user says goes
// in as the session's input, and what Claude Code does comes back as the
// session's transcript, status and progress.

import {
	getSessionInfo,
	query,
	type CanUseTool,
	type EffortLevel,
	type PermissionMode,
	type PermissionResult,
	type Query,
	type SDKMessage,
	type SDKSessionInfo,
	type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionRecordBase, SessionStore } from 'cohesion-agent-kit';
import type { ActorSaidContent, ActorSessionReport, ActorSessionStatus, ActorUserContent, Client, ClientImage, ContextUsage } from 'cohesion-ts';

import { COHESION_INSTRUCTIONS } from './instructions.ts';
import { imageBlocks, imagesIn, readsImage, sendable } from './images.ts';
import { contextOf, contextUsage, liveContext, windowOf, type Usage } from './usage.ts';
import { AFTER_PLAN, PLAN_TOOL, QUESTION_TOOL, describe, progress, request, result, toolUse } from './translate.ts';

/** How long a session's process stays up with nothing to do before it exits; the next message resumes it. */
const LINGER = 10 * 60_000;
/**
 * How long after its background work is done a session whose turn had ended
 * waits for Claude Code to take that work's results up in a turn of its
 * own, before it is idle without one.
 */
const RESUME = 10_000;

/** What is kept on disk of one actor session, by Cohesion's id for it, so a restart resumes its Claude Code session. */
export interface SessionRecord extends SessionRecordBase {
	/** The Claude Code session the actor session runs in. */
	session_id: string;
	/** Whether the session exists yet, so the next stretch resumes it. */
	started: boolean;
	mode: PermissionMode;
}

/** What a session needs from the client around it. */
export interface ActorSessionContext {
	client: Client;
	store: SessionStore<SessionRecord>;
	/** The actor's directory. */
	cwd: string;
	/** Where the session says how much of the actor's limits it has used. */
	usage: Usage;
	log: (message: string) => void;
}

/** The input of one running Claude Code process, which ends when closed. */
class Input implements AsyncIterable<SDKUserMessage> {
	private queued: SDKUserMessage[] = [];
	private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
	private closed = false;

	push(text: string, images: ClientImage[] = []): void {
		const content = images.length ? [...(text ? [{ type: 'text' as const, text }] : []), ...imageBlocks(images)] : text;
		const message: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
		if (this.waiting) {
			this.waiting({ value: message, done: false });
			this.waiting = null;
		} else this.queued.push(message);
	}

	close(): void {
		this.closed = true;
		this.waiting?.({ value: undefined, done: true });
		this.waiting = null;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const message = this.queued.shift();
				if (message) return Promise.resolve({ value: message, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => (this.waiting = resolve));
			},
		};
	}
}

/** A running Claude Code process for the session. */
interface Stretch {
	query: Query;
	input: Input;
	linger: ReturnType<typeof setTimeout> | null;
	/** Whether its input is closed, so it is ending and answers nothing more. */
	closed?: boolean;
}

export class ActorSession {
	/** Where the session stands, as this client last reported it. */
	status: ActorSessionStatus = 'idle';
	private progress: string | null = null;
	private stretch: Stretch | null = null;
	/** The requests waiting on the user, by their message's id. */
	private readonly waiting = new Map<number, (response: ActorUserContent | null) => void>();
	/**
	 * The tool uses waiting on their results, by Claude Code's id for them,
	 * with the ids of the messages that showed them once their replies come,
	 * for the `end` each gets when the tool finishes. One whose result
	 * may hold images is `held`, reported once the result comes, with its
	 * images.
	 */
	private readonly uses = new Map<string, Use>();
	/**
	 * The tool uses of background subagents, by Claude Code's id for them:
	 * their result came at once, as a placeholder, but the tool is not done
	 * until the agent is, which a `task_notification` says.
	 */
	private readonly launched = new Map<string, Use>();
	private stopping = false;
	/** How many tokens the session's context holds at most, once Claude Code has said. */
	private window: number | null = null;
	/**
	 * How many times the context has been said or asked for: a reading
	 * that comes back after a later one, or after a newer number, is stale.
	 */
	private contextCount = 0;
	/** The context last said to cohesiond, which keeps it with the session. */
	private said: ContextUsage | null = null;
	/** Whether Claude Code's title is being read, so another read waits for the next step. */
	private titling = false;
	/**
	 * The subagents and workflows Claude Code runs in the background, by
	 * its id for them, as the running process last said: until they are
	 * done the turn isn't, since Claude Code takes their results up once
	 * they come.
	 */
	private background: string[] = [];
	/**
	 * Whether Claude Code's turn has ended with background work still
	 * running, so the session stays working for it; with the timer that makes
	 * it idle should that work end with no turn of Claude Code's to follow.
	 */
	private held: { resume: ReturnType<typeof setTimeout> | null } | null = null;
	/** Whether something was said that no turn has begun on yet, so the next turn is the user's or a wake's. */
	private told = false;
	/**
	 * Who started the turn under way, known from its first step: `asked` by
	 * what was said, or Claude Code on its `own`, such as over a background
	 * shell's or monitor's notification. An `own` turn isn't reported working
	 * until it uses a tool, so one that only speaks ends with no second stop.
	 */
	private turn: 'asked' | 'own' | null = null;

	constructor(
		readonly id: number,
		private record: SessionRecord,
		private readonly context: ActorSessionContext,
	) {}

	/**
	 * Hands the session what the user said, with the images they attached: more
	 * to do, or a response to a request. Words said while requests wait pass
	 * them over: Claude Code, held on them, hears the words as their answer
	 * and carries on.
	 */
	hear(content: ActorUserContent, images: ClientImage[] = []): void {
		if (content.kind === 'text') {
			if (this.waiting.size === 0) return this.say(content.text, images);
			for (const answer of [...this.waiting.values()]) answer(content);
			if (images.length) this.say('The images I attached to my reply:', images);
			return;
		}
		const answer = this.waiting.get(content.request_id);
		if (!answer) {
			// Asked by a process that has since ended: Claude Code reads it as words.
			return this.say(describe(content), images);
		}
		answer(content);
		// A response can't carry images to Claude Code, so they follow it.
		if (images.length) this.say('The images I attached to my response:', images);
	}

	/** Starts a turn with `text` and `images`, or adds them to the turn under way. */
	say(text: string, images: ClientImage[] = []): void {
		const stretch = this.stretch ?? this.open();
		if (stretch.linger) clearTimeout(stretch.linger);
		stretch.linger = null;
		stretch.input.push(text, images);
		this.told = true;
		void this.resume();
		// cohesiond sets a session the user speaks to working itself.
		this.status = 'working';
	}

	/** Stops the turn under way; the session is idle until the user says more. */
	async stop(): Promise<void> {
		const busy = this.status === 'working' || this.status === 'needsAttention';
		const held = this.held;
		this.unhold();
		this.status = 'idle';
		this.progress = null;
		const { stretch } = this;
		if (!stretch || !busy) return;
		// The background work goes too, or Claude Code would take it up again once done.
		for (const id of this.background) {
			stretch.query.stopTask(id).catch((error: Error) => this.context.log(`session ${this.id}: couldn't stop task ${id}: ${error.message}`));
		}
		// A held turn has ended already: there's nothing to interrupt.
		if (held) return;
		this.stopping = true;
		for (const answer of this.waiting.values()) answer(null);
		await stretch.query.interrupt();
	}

	/** Runs the session in `mode` from its next step on, leaving its status as it is. */
	async setMode(mode: PermissionMode): Promise<void> {
		// A mode the process refuses leaves the old one, as cohesiond does.
		await this.stretch?.query.setPermissionMode(mode);
		this.record = { ...this.record, mode };
		this.context.store.put(this.id, this.record);
	}

	/** Reports where the session stands, for a session that just began: cohesiond forgot. */
	async resync(report: (report: ActorSessionReport) => Promise<unknown>): Promise<void> {
		if (this.status !== 'working' && this.status !== 'needsAttention') return;
		await report({ kind: 'status', status: this.status });
		await report({ kind: 'progress', progress: this.progress });
		// Said while cohesiond was away, it may not have kept it.
		if (this.record.titled === 'pending' && this.record.title) await report({ kind: 'title', title: this.record.title });
	}

	private open(): Stretch {
		const { record } = this;
		const input = new Input();
		// Claude Code says its background work afresh for each process.
		this.background = [];
		// Agents the last process launched ended with it.
		void this.finish();
		// A turn the last process left unfinished ended with it.
		this.turn = null;
		const stretch: Stretch = {
			input,
			linger: null,
			query: query({
				prompt: input,
				options: {
					cwd: this.context.cwd,
					permissionMode: record.mode,
					// Claude Code refuses bypassPermissions without it, even when
					// the user switches to it mid-run.
					allowDangerouslySkipPermissions: true,
					model: record.model ?? undefined,
					effort: (record.effort as EffortLevel | null) ?? undefined,
					// Left to itself Claude Code keeps its thinking's text from the SDK.
					thinking: { type: 'adaptive', display: 'summarized' },
					// The Claude Code session goes by the given title rather than one of its own.
					...(!record.started && record.titled === 'given' && record.title ? { title: record.title } : {}),
					...(record.started ? { resume: record.session_id } : { sessionId: record.session_id }),
					settingSources: ['user', 'project', 'local'],
					systemPrompt: { type: 'preset', preset: 'claude_code', append: COHESION_INSTRUCTIONS },
					// Bypass never consults it, but the user may switch to a mode that does.
					canUseTool: this.prompt,
					stderr: (data) => this.context.log(`session ${this.id}: ${data.trimEnd()}`),
				},
			}),
		};
		this.stretch = stretch;
		this.context.usage.track(stretch.query);
		void this.context.usage.pull(stretch.query);
		void this.run(stretch);
		return stretch;
	}

	/** Reads what Claude Code does until its process ends. */
	private async run(stretch: Stretch): Promise<void> {
		try {
			for await (const message of stretch.query) await this.handle(message, stretch);
		} catch (error) {
			this.context.log(`session ${this.id}: ${error instanceof Error ? error.message : String(error)}`);
			if (this.stretch === stretch && !this.stopping) {
				await this.report({ kind: 'message', content: { kind: 'text', text: `Claude Code stopped: ${error instanceof Error ? error.message : error}` } });
				await this.setStatus('failed');
			}
		} finally {
			stretch.closed = true;
			this.context.usage.untrack(stretch.query);
			if (this.stretch === stretch) {
				this.stretch = null;
				await this.release();
				await this.finish();
				// Its background work ended with it.
				this.background = [];
				if (this.held) await this.settle();
			}
		}
	}

	/** Reports the tool uses still held, whose results never came. */
	private async release(): Promise<void> {
		const held = [...this.uses.values()].filter((use) => use.held);
		this.uses.clear();
		for (const use of held) await this.show(use.content);
	}

	/** Ends the tool uses of background agents that are no more. */
	private async finish(): Promise<void> {
		const launched = [...this.launched.values()];
		this.launched.clear();
		for (const use of launched) await this.end(use);
	}

	/** Reports that `use`'s tool has ended, once each message showing it has its id. */
	private async end(use: Use): Promise<void> {
		for (const shown of use.shown) {
			const { id } = await shown;
			// A refused one has nothing to end.
			if (id !== -1) await this.report({ kind: 'end', message_id: id });
		}
	}

	/**
	 * Reports a stretch of thinking and ends it at once: Claude Code gives
	 * its text only once it is done, and a message's text can't change later.
	 */
	private async think(text: string): Promise<void> {
		const { id } = await this.report({ kind: 'message', content: { kind: 'thinking', text, ended_at: null } });
		// A refused one has nothing to end.
		if (id !== -1) await this.report({ kind: 'end', message_id: id });
	}

	/**
	 * Reports `content` in the transcript with the `images` cohesiond will
	 * take, saying so when there are some it can't show: it refuses a whole
	 * message for one image, so a refused one goes again without them.
	 */
	private async show(content: ActorSaidContent, images: ClientImage[] = []): Promise<{ id: number }> {
		const checked = sendable(images);
		for (const why of checked.dropped) this.context.log(`session ${this.id}: an image can't be shown: ${why}`);
		let dropped = checked.dropped.length;
		let message: { id: number };
		if (checked.images.length) {
			try {
				message = await this.context.client.report(this.id, { kind: 'message', content, images: checked.images });
			} catch (error) {
				this.context.log(`session ${this.id}: update with images refused: ${(error as Error).message}`);
				dropped += checked.images.length;
				message = await this.report({ kind: 'message', content });
			}
		} else message = await this.report({ kind: 'message', content });
		if (dropped && message.id !== -1) {
			await this.report({ kind: 'message', content: { kind: 'text', text: unshown(dropped) } });
		}
		return message;
	}

	private async handle(message: SDKMessage, stretch: Stretch): Promise<void> {
		switch (message.type) {
			case 'system':
				if (message.subtype === 'init') {
					// A turn begins, perhaps Claude Code's own on its background work's results.
					await this.resume();
					// Learns the window before the first turn's steps, and shows a resumed session's context.
					void this.readContext(stretch);
					if (!this.record.started) {
						this.record = { ...this.record, started: true };
						this.context.store.put(this.id, this.record);
					}
				} else if (message.subtype === 'compact_boundary') {
					// The steps after it count from what compaction left.
					const after = message.compact_metadata.post_tokens;
					if (after !== undefined && this.window) this.setContext(contextUsage(after, this.window));
				} else if (message.subtype === 'task_notification') {
					// The background agent a tool use launched is done: so is the tool.
					const use = message.tool_use_id ? this.launched.get(message.tool_use_id) : undefined;
					if (use && message.tool_use_id) {
						this.launched.delete(message.tool_use_id);
						await this.end(use);
					}
				} else if (message.subtype === 'background_tasks_changed') {
					this.background = message.tasks.filter(keepsWorking).map((task) => task.task_id);
					if (this.held) await this.hold(stretch);
				}
				return;
			case 'rate_limit_event':
				this.context.usage.rateLimit(message.rate_limit_info);
				return;
			case 'assistant': {
				// A subagent's own steps stay inside its tool use.
				if (message.parent_tool_use_id) return;
				await this.resume();
				// The step's own count at once, then `/context`'s, which counts more, while its tools run.
				this.setContext(liveContext(message.message.usage, this.window));
				const usesTool = message.message.content.some((block) => block.type === 'tool_use');
				if (usesTool) void this.readContext(stretch);
				if (!this.turn) {
					this.turn = this.told ? 'asked' : 'own';
					this.told = false;
				}
				if (this.status !== 'working' && this.waiting.size === 0 && (this.turn === 'asked' || usesTool)) await this.setStatus('working');
				void this.readTitle();
				// Images Claude shows go with what it says, or else with its first step.
				let images = imagesIn(message.message.content);
				const text = message.message.content.some((block) => block.type === 'text' && block.text.trim());
				for (const block of message.message.content) {
					if (block.type === 'thinking' && block.thinking.trim()) {
						await this.think(block.thinking);
					} else if (block.type === 'text' && block.text.trim()) {
						await this.show({ kind: 'text', text: block.text }, images);
						images = [];
					} else if (block.type === 'tool_use' && block.name !== QUESTION_TOOL && block.name !== PLAN_TOOL) {
						const input = (block.input ?? {}) as Record<string, unknown>;
						const content = toolUse(block.name, input, this.context.cwd);
						const use: Use = { content, held: showsImages(block.name, input), shown: [] };
						this.uses.set(block.id, use);
						if (!use.held) {
							use.shown.push(this.show(content, text ? [] : images));
							await use.shown[0];
							if (!text) images = [];
						}
						await this.setProgress(progress(block.name, input, this.context.cwd));
					}
				}
				if (images.length) this.context.log(`session ${this.id}: ${images.length} image(s) with nothing to show them with`);
				return;
			}
			case 'user': {
				// What a tool gave back, failed or not: a held tool use is reported now,
				// with its images, and the tool has ended.
				// Anything else, such as the instructions a skill loads after its
				// Skill tool use, is for Claude, not the transcript: dropped on purpose.
				if (message.parent_tool_use_id || typeof message.message.content === 'string') return;
				for (const block of message.message.content) {
					if (block.type !== 'tool_result') continue;
					const images = imagesIn(block.content);
					const use = this.uses.get(block.tool_use_id);
					if (!use) continue;
					this.uses.delete(block.tool_use_id);
					// A background agent's result is a placeholder: its tool is done with it.
					const launches = isAgentLaunch(use, message.tool_use_result);
					if (launches) this.launched.set(block.tool_use_id, use);
					// One reported already that gave images after all is shown again, with them.
					if (use.held || images.length) use.shown.push(this.show(use.content, images));
					if (!launches) await this.end(use);
				}
				return;
			}
			case 'result': {
				const stopped = this.stopping;
				this.stopping = false;
				// A turn of Claude Code's own that was never reported has nothing to end, whatever the session's status.
				const unreported = this.turn === 'own' && this.status !== 'working';
				// One with no step of its own still took up what was said.
				if (!this.turn) this.told = false;
				this.turn = null;
				void this.measure(stretch, windowOf(message.modelUsage ?? {}));
				void this.readTitle();
				await this.release();
				if (message.subtype === 'success' && !message.is_error) {
					// The turn isn't over while its background work runs.
					if (this.background.length && !stopped) return this.hold(stretch);
					await this.setProgress(null);
					if (!unreported) await this.setStatus('idle');
				} else {
					await this.setProgress(null);
					if (stopped) this.status = 'idle';
					else {
						const why = message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype;
						await this.report({ kind: 'message', content: { kind: 'text', text: why } });
						await this.setStatus('failed');
					}
				}
				this.linger(stretch);
				return;
			}
		}
	}

	/**
	 * Keeps the session working once Claude Code's turn has ended with
	 * background work running, saying what it waits on. Once that work is
	 * done Claude Code takes its results up in a turn of its own, which
	 * ends the wait; should none begin soon, the session is idle anyway.
	 */
	private async hold(stretch: Stretch): Promise<void> {
		const held = (this.held ??= { resume: null });
		if (held.resume) clearTimeout(held.resume);
		held.resume = null;
		if (this.background.length) return this.setProgress(waitingOn(this.background.length));
		await this.setProgress(null);
		held.resume = setTimeout(() => {
			if (this.held !== held || this.stretch !== stretch) return;
			void this.settle().then(() => this.linger(stretch));
		}, RESUME);
	}

	/** Ends the wait on background work, should the session be waiting on it. */
	private unhold(): void {
		if (this.held?.resume) clearTimeout(this.held.resume);
		this.held = null;
	}

	/** Ends the wait on background work for a turn that begins, clearing what it waited on. */
	private async resume(): Promise<void> {
		if (!this.held) return;
		this.unhold();
		await this.setProgress(null);
	}

	/** Makes a session that waited on its background work idle: the turn is over. */
	private async settle(): Promise<void> {
		this.unhold();
		await this.setProgress(null);
		await this.setStatus('idle');
	}

	/** Lets `stretch`'s process go once it has had nothing to do for a while. */
	private linger(stretch: Stretch): void {
		if (stretch.linger) clearTimeout(stretch.linger);
		stretch.linger = setTimeout(() => {
			if (this.stretch !== stretch || this.status === 'working') return;
			this.stretch = null;
			stretch.closed = true;
			stretch.input.close();
		}, LINGER);
	}

	/**
	 * Says how full the session's context is after a turn, as `/context`
	 * counts it, from the last response, and the plan's limits. `size` is
	 * the window's size, should `/context` fail.
	 */
	private async measure(stretch: Stretch, size: number | null): Promise<void> {
		if (!(await this.readContext(stretch))) this.window = size ?? this.window;
		// Every turn moves the plan's limits.
		await this.context.usage.pull(stretch.query, true);
	}

	/**
	 * Asks the running Claude Code how full the context is, as `/context`
	 * counts it in summary, which costs no tokens and is safe mid-turn,
	 * and says it unless a newer number was said meanwhile. Learns the
	 * window either way. Never fails: what it can't read is null.
	 */
	private async readContext(stretch: Stretch): Promise<ContextUsage | null> {
		if (stretch.closed) return null;
		const count = ++this.contextCount;
		let context = null;
		try {
			context = contextOf(await stretch.query.getContextUsage({ detail: 'summary' }));
		} catch (error) {
			this.context.log(`session ${this.id}: couldn't read the context's usage: ${(error as Error).message}`);
		}
		if (context) this.window = context.total_tokens;
		if (count === this.contextCount) this.setContext(context);
		return context;
	}

	/** Says how full the context is now, unless unchanged, making any reading still under way stale. */
	private setContext(context: ContextUsage | null): void {
		if (!context) return;
		this.contextCount++;
		if (context.used_tokens === this.said?.used_tokens && context.total_tokens === this.said.total_tokens) return;
		this.said = context;
		void this.report({ kind: 'context', context });
	}

	/**
	 * Says Claude Code's title for the session as the session's, for a session
	 * Cohesion titled with its prompt's first line, once Claude Code has
	 * one and whenever it changes (`/rename`, say). Claude Code has no
	 * message for it, so each step asks. Never fails.
	 */
	private async readTitle(): Promise<void> {
		if (this.record.titled !== 'pending' || this.titling) return;
		this.titling = true;
		try {
			const title = titleToSend(this.record, await getSessionInfo(this.record.session_id, { dir: this.context.cwd }));
			if (!title) return;
			this.record = { ...this.record, title };
			this.context.store.put(this.id, this.record);
			await this.report({ kind: 'title', title });
		} catch (error) {
			this.context.log(`session ${this.id}: couldn't read the session's title: ${(error as Error).message}`);
		} finally {
			this.titling = false;
		}
	}

	/**
	 * Claude Code's permission prompt, which also carries its questions and
	 * plans: made a request in the transcript, needing attention until the
	 * user responds.
	 */
	private readonly prompt: CanUseTool = async (name, input, options): Promise<PermissionResult> => {
		const asked = request(name, input, options, this.context.cwd);
		const message = await this.report({ kind: 'message', content: asked });
		const response = await new Promise<ActorUserContent | null>((resolve) => {
			this.waiting.set(message.id, resolve);
			options.signal.addEventListener('abort', () => resolve(null), { once: true });
			void this.setStatus('needsAttention');
		});
		this.waiting.delete(message.id);
		if (!response) return { behavior: 'deny', message: 'Stopped.', interrupt: true };
		if (this.waiting.size === 0 && !this.stopping) await this.setStatus('working');
		if (name === PLAN_TOOL && response.kind === 'plan' && response.approved && this.record.mode === 'plan') {
			// The approved plan moves the session to Auto; a later process mustn't go back.
			this.record = { ...this.record, mode: AFTER_PLAN };
			this.context.store.put(this.id, this.record);
		}
		return result(name, input, options, response);
	};

	private async setStatus(status: ActorSessionStatus): Promise<void> {
		if (this.status === status) return;
		this.status = status;
		await this.report({ kind: 'status', status });
	}

	private async setProgress(progress: string | null): Promise<void> {
		if (this.progress === progress) return;
		this.progress = progress;
		await this.report({ kind: 'progress', progress });
	}

	private report(report: Extract<ActorSessionReport, { kind: 'message' }>): Promise<{ id: number }>;
	private report(report: ActorSessionReport): Promise<unknown>;
	private report(report: ActorSessionReport): Promise<unknown> {
		return this.context.client.report(this.id, report).catch((error: Error) => {
			// Refused, such as for a session cohesiond no longer has: dropped.
			this.context.log(`session ${this.id}: update refused: ${error.message}`);
			return { id: -1 };
		});
	}
}

/** A tool use waiting on its result. */
interface Use {
	content: Extract<ActorSaidContent, { kind: 'toolUse' }>;
	held: boolean;
	/** The messages showing it, settling with their ids. */
	shown: Promise<{ id: number }>[];
}

/**
 * The title to say for a session kept as `record`, from Claude Code's `info`
 * on its session, or null for none: only for a session whose title is
 * pending, once Claude Code has a title (its own or one set with
 * `/rename`, never the first prompt it otherwise falls back on), and not
 * the one said last.
 */
export function titleToSend(record: SessionRecord, info: SDKSessionInfo | undefined): string | null {
	if (record.titled !== 'pending') return null;
	const title = info?.customTitle?.trim();
	return title && title !== record.title ? title : null;
}

/**
 * Whether Claude Code's background task `task` keeps the turn going: a
 * subagent or workflow, whose result Claude Code takes up once it comes.
 * A shell, monitor or MCP task may run for good, such as a dev server, and
 * one Claude Code calls ambient isn't activity at all.
 */
export function keepsWorking(task: { task_type: string; ambient?: boolean }): boolean {
	return !task.ambient && (task.task_type === 'local_agent' || task.task_type === 'local_workflow');
}

/** The progress of a session waiting on `count` subagents or workflows. */
function waitingOn(count: number): string {
	return count === 1 ? 'Waiting on a background agent' : `Waiting on ${count} background agents`;
}

/** Whether tool `name` may give back images, so its use waits for its result. */
function showsImages(name: string, input: Record<string, unknown>): boolean {
	return name.startsWith('mcp__') || (name === 'Read' && typeof input.file_path === 'string' && readsImage(input.file_path));
}

/** The note in place of images that couldn't be shown. */
function unshown(count: number): string {
	return count === 1 ? "(An image couldn't be shown here.)" : `(${count} images couldn't be shown here.)`;
}

/** Whether a tool result is the placeholder of an agent launched in the background, not its real result. */
function isAgentLaunch(use: Use, result: unknown): boolean {
	return use.content.category === 'agent' && (result as { status?: unknown } | null | undefined)?.status === 'async_launched';
}
