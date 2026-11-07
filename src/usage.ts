// How much of its limits each actor has used, as cohesiond shows it: the
// plan limits of the account Claude Code runs on, which every actor shares,
// and how a session's context window is counted, which the session says itself.

import { homedir } from 'node:os';

import {
	query,
	type AccountInfo,
	type ModelUsage,
	type Query,
	type SDKControlGetContextUsageResponse,
	type SDKControlGetUsageResponse,
	type SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type { ActorUsage, ContextUsage, PlanUsage, UsagePool } from 'cohesion-ts';

/** The most plan limits, and label bytes, cohesiond takes. */
const MOST_LIMITS = 8;
const LONGEST_LABEL = 64;
/** The longest pool id and name, in bytes, cohesiond takes. */
const LONGEST_POOL_ID = 256;
const LONGEST_POOL_NAME = 128;
/** How long after one pull another is skipped, unless forced: it would say the same. */
const PULL_GAP = 3_000;
/** How often the plan's limits are pulled, sessions running or not. */
const PULL_EVERY = 5 * 60_000;

/** A plan limit, by Claude Code's name for it (`five_hour`, `seven_day`, ...). */
export type Limits = Map<string, PlanUsage>;

/** The labels of the limits with names of their own. */
const LABELS: Record<string, string> = {
	five_hour: '5-hour limit',
	seven_day: 'Weekly limit',
	seven_day_opus: 'Weekly Opus limit',
	seven_day_sonnet: 'Weekly Sonnet limit',
	seven_day_oauth_apps: 'Weekly OAuth apps limit',
};

/**
 * The label of limit `key`, or null for one that isn't a plan window, such
 * as overage or extra usage, or a name Claude Code hasn't made public.
 */
export function label(key: string): string | null {
	if (LABELS[key]) return LABELS[key];
	if (key.startsWith('model:')) return `Weekly ${key.slice('model:'.length)} limit`;
	const window = /^(five_hour|seven_day)_([a-z_]+)$/.exec(key);
	if (!window || key.includes('overage')) return null;
	const words = window[2]!.split('_').map((word) => word[0]!.toUpperCase() + word.slice(1));
	return `${window[1] === 'five_hour' ? '5-hour' : 'Weekly'} ${words.join(' ')} limit`;
}

/** Whether `account`'s sessions have plan limits: a claude.ai subscription, not an API key, Bedrock or Vertex. */
export function hasPlan(account: AccountInfo): boolean {
	return !!account.subscriptionType && (!account.apiProvider || account.apiProvider === 'firstParty');
}

/**
 * The pool `account`'s plan limits belong to, which every Claude Code
 * signed in to it shares, on any device: its email, within its
 * organization when it has one. Null without a plan or an email, or when
 * either is too long for cohesiond.
 */
export function poolOf(account: AccountInfo): UsagePool | null {
	if (!hasPlan(account) || !account.email) return null;
	const id = `claude:${account.email}${account.organization ? `/${account.organization}` : ''}`;
	const bytes = (text: string) => new TextEncoder().encode(text).length;
	if (bytes(id) > LONGEST_POOL_ID || bytes(account.email) > LONGEST_POOL_NAME) return null;
	return { id, name: account.email };
}

/**
 * The limits a `rate_limit_event` names: the one it is about, and the
 * windows it lists beside it (`unifiedWindows`, which the SDK doesn't
 * type). Its utilization is a fraction, from 0 to 1, and its reset time
 * Unix seconds.
 */
export function rateLimitLimits(info: SDKRateLimitInfo): Limits {
	const limits: Limits = new Map();
	const add = (key: string | undefined, utilization: unknown, resetsAt: unknown) => {
		const name = key && label(key);
		if (!name || typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
		limits.set(key, limit(name, utilization, typeof resetsAt === 'number' ? resetsAt : null));
	};
	add(info.rateLimitType, info.utilization, info.resetsAt);
	const windows = (info as { unifiedWindows?: unknown }).unifiedWindows;
	if (windows && typeof windows === 'object') {
		for (const [key, window] of Object.entries(windows)) {
			if (!window || typeof window !== 'object') continue;
			const { utilization, resetsAt } = window as { utilization?: unknown; resetsAt?: unknown };
			add(key, utilization, resetsAt);
		}
	}
	return limits;
}

/**
 * The limits `/usage` lists, or null when the account has no plan limits.
 * Its utilization is a percentage, and its reset time ISO 8601.
 */
export function pulledLimits(usage: SDKControlGetUsageResponse): Limits | null {
	if (!usage.rate_limits_available || !usage.rate_limits) return null;
	const limits: Limits = new Map();
	const add = (key: string, window: unknown) => {
		const name = label(key);
		if (!name || !window || typeof window !== 'object') return;
		const { utilization, resets_at } = window as { utilization?: unknown; resets_at?: unknown };
		if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
		limits.set(key, limit(name, utilization / 100, typeof resets_at === 'string' ? unixSeconds(resets_at) : null));
	};
	for (const [key, window] of Object.entries(usage.rate_limits)) {
		if (key !== 'model_scoped') add(key, window);
	}
	for (const model of usage.rate_limits.model_scoped ?? []) {
		if (typeof model?.display_name === 'string' && model.display_name) add(`model:${model.display_name}`, model);
	}
	return limits;
}

/** The context window as `/context` counts it, or null when it doesn't say how big it is. */
export function contextOf(context: SDKControlGetContextUsageResponse): ContextUsage | null {
	return contextUsage(context.totalTokens, context.maxTokens);
}

/** The context an assistant message's usage fills, with its whole size. */
export function liveContext(usage: unknown, size: number | null): ContextUsage | null {
	if (!usage || typeof usage !== 'object' || !size) return null;
	const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = usage as Record<string, unknown>;
	const count = (tokens: unknown) => (typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0);
	const used = count(input_tokens) + count(cache_creation_input_tokens) + count(cache_read_input_tokens) + count(output_tokens);
	return used ? contextUsage(used, size) : null;
}

/** The largest context window among a result's models: the main one's. */
export function windowOf(models: Record<string, ModelUsage>): number | null {
	const sizes = Object.values(models).map((model) => model.contextWindow).filter((size) => Number.isFinite(size) && size > 0);
	return sizes.length ? Math.max(...sizes) : null;
}

/** The order limits show in: the 5-hour one, the weekly one, then the rest as they came. */
function rank(key: string): number {
	const order = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
	const at = order.indexOf(key);
	return at === -1 ? order.length : at;
}

function limit(name: string, used: number, resetsAt: number | null): PlanUsage {
	return {
		label: truncate(name),
		used: Math.min(1, Math.max(0, used)),
		...(resetsAt !== null && Number.isFinite(resetsAt) ? { resets_at: Math.round(resetsAt) } : {}),
	};
}

/** `used` tokens of a `total`-token window, or null when either makes no sense. */
export function contextUsage(used: number, total: number): ContextUsage | null {
	if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
	return { used_tokens: Math.max(0, Math.round(used)), total_tokens: Math.round(total) };
}

function unixSeconds(iso: string): number | null {
	const at = Date.parse(iso);
	return Number.isNaN(at) ? null : Math.round(at / 1000);
}

function truncate(label: string): string {
	const bytes = new TextEncoder().encode(label);
	if (bytes.length <= LONGEST_LABEL) return label;
	return new TextDecoder().decode(bytes.slice(0, LONGEST_LABEL)).replace(/�+$/, '');
}

/** A Claude Code started without a prompt, which waits until closed. */
function idleClaudeCode(): Query {
	const idle = new Promise<never>(() => {});
	return query({
		prompt: (async function* () {
			yield await idle;
		})(),
		options: { cwd: homedir() },
	});
}

/** Sends one actor's usage; may fail, as an older cohesiond refuses it. */
export type SendUsage = (actor: string, usage: ActorUsage) => Promise<void>;

/**
 * The plan usage of this client's actors, said to cohesiond whenever it
 * changes. Claude Code's plan limits are its account's, so every actor
 * offered says the same ones, naming the account as their pool. Nothing
 * here ever fails a session: what Claude Code can't say is left out.
 */
export class Usage {
	/** Whether the account has plan limits; null until known. */
	private plan: boolean | null = null;
	/** The account's pool, once known. */
	private pool: UsagePool | null = null;
	private readonly limits: Limits = new Map();
	/** What each actor last said, as JSON. */
	private readonly said = new Map<string, string>();
	private lastPull = 0;
	private refused = false;
	/** The pull under way, and a forced one waiting for it to end. */
	private pulling: Promise<void> | null = null;
	private again: Promise<void> | null = null;
	/** The Claude Codes running sessions, which the timer pulls through. */
	private readonly running = new Set<Query>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly spawn: () => Query;
	private readonly gap: number;
	private readonly every: number;

	constructor(
		private readonly send: SendUsage,
		private actors: () => string[],
		private readonly log: (message: string) => void,
		options: { spawn?: () => Query; gap?: number; every?: number } = {},
	) {
		this.spawn = options.spawn ?? idleClaudeCode;
		this.gap = options.gap ?? PULL_GAP;
		this.every = options.every ?? PULL_EVERY;
	}

	/** Pulls the plan's limits now and every few minutes after, until `stop`. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.every);
		// It never keeps the client from exiting.
		this.timer.unref?.();
		void this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Has the timer pull through `query` while it runs a session, rather than start a Claude Code of its own. */
	track(query: Query): void {
		this.running.add(query);
	}

	untrack(query: Query): void {
		this.running.delete(query);
	}

	/** One of the timer's pulls: through a session's Claude Code, or one started without a prompt when none runs. */
	async tick(): Promise<void> {
		try {
			const [running] = this.running;
			await (running ? this.pull(running) : this.probe());
		} catch (error) {
			this.log(`Couldn't read the plan's limits: ${(error as Error).message}`);
		}
	}

	/** Learns the account's plan limits without a session, from a Claude Code started without a prompt. */
	async probe(): Promise<void> {
		if (this.recent()) return;
		const probe = this.spawn();
		try {
			await this.pull(probe);
		} finally {
			probe.close();
		}
	}

	/**
	 * Asks a running Claude Code for the account and its plan limits, the
	 * whole picture, unless a pull is under way or just ended. A forced
	 * pull, after a turn, always asks: after the one under way, if any.
	 */
	pull(running: Query, force = false): Promise<void> {
		if (this.pulling) {
			if (!force) return this.pulling;
			this.again ??= this.pulling.then(() => {
				this.again = null;
				return this.pull(running, true);
			});
			return this.again;
		}
		if (!force && this.recent()) return Promise.resolve();
		this.lastPull = Date.now();
		this.pulling = this.read(running).finally(() => {
			this.pulling = null;
		});
		return this.pulling;
	}

	private recent(): boolean {
		return !!this.pulling || Date.now() - this.lastPull < this.gap;
	}

	/**
	 * Reads the account and its plan limits. Its `/usage` data is
	 * experimental: when it fails, the limits its rate limit events named
	 * stand. An answer from Claude Code's cache leaves out the per-model
	 * limits, so those it doesn't name stand too.
	 */
	private async read(running: Query): Promise<void> {
		if (this.plan === null) {
			try {
				this.setAccount(await running.accountInfo());
			} catch (error) {
				this.log(`Couldn't read the account: ${(error as Error).message}`);
			}
		}
		if (this.plan !== false) {
			try {
				const pulled = pulledLimits(await running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
				if (pulled) for (const [key, limit] of pulled) this.limits.set(key, limit);
			} catch (error) {
				this.log(`Couldn't read the plan's limits: ${(error as Error).message}`);
			}
		}
		this.flush();
	}

	/** Takes what a rate limit event says, keeping the limits it doesn't name. */
	rateLimit(info: SDKRateLimitInfo): void {
		// Only claude.ai subscribers get them.
		if (this.plan === false) return;
		for (const [key, limit] of rateLimitLimits(info)) this.limits.set(key, limit);
		this.flush();
	}

	/** What every actor says now: the plan's limits, when it has any, and the account's pool, once known. */
	usageOf(): ActorUsage {
		const plan =
			this.plan === false
				? []
				: [...this.limits.entries()]
						.sort(([a], [b]) => rank(a) - rank(b))
						.slice(0, MOST_LIMITS)
						.map(([, limit]) => limit);
		if (!plan.length) return {};
		return this.pool ? { plan, pool: this.pool } : { plan };
	}

	/** Says each offered actor's usage that changed, forgetting the actors no longer offered. */
	flush(): void {
		const actors = this.actors();
		for (const actor of this.said.keys()) {
			if (!actors.includes(actor)) this.said.delete(actor);
		}
		const usage = this.usageOf();
		const json = JSON.stringify(usage);
		for (const actor of actors) {
			if (json === (this.said.get(actor) ?? '{}')) continue;
			this.said.set(actor, json);
			this.send(actor, usage).catch((error: Error) => {
				// An older cohesiond refuses every one: said once.
				if (this.refused) return;
				this.refused = true;
				this.log(`Usage refused: ${error.message}`);
			});
		}
	}

	private setAccount(account: AccountInfo): void {
		this.plan = hasPlan(account);
		this.pool = poolOf(account);
		if (!this.plan) this.limits.clear();
	}
}
