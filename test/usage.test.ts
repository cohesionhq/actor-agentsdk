import { expect, test } from 'bun:test';

import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ActorUsage } from 'cohesion-ts';

import { Usage, label, liveContext, poolOf, pulledLimits, rateLimitLimits } from '../src/usage.ts';
import { session } from './fake_session.ts';

// As Claude Code 0.3.312 sends them for a Max account.
const event = {
	status: 'allowed',
	resetsAt: 1793293200,
	rateLimitType: 'five_hour',
	unifiedWindows: {
		five_hour: { utilization: 0.41, resetsAt: 1793293200, status: 'allowed' },
		seven_day: { utilization: 0.15, resetsAt: 1793732400, status: 'allowed' },
	},
} as unknown as SDKRateLimitInfo;
const pulled = {
	subscription_type: 'max',
	rate_limits_available: true,
	rate_limits: {
		five_hour: { utilization: 41, resets_at: '2026-10-29T16:59:59.953533+00:00' },
		seven_day: { utilization: 16, resets_at: '2026-11-03T18:59:59.953549+00:00' },
		seven_day_opus: null,
		iguana_necktie: { utilization: 3, resets_at: null },
		extra_usage: { is_enabled: false, utilization: null },
		model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-11-03T19:00:00+00:00' }],
	},
} as unknown as SDKControlGetUsageResponse;

/** A Usage for actors `a` and `b`, keeping what each said. */
function usage(actors = ['a', 'b'], refuse = false, options: ConstructorParameters<typeof Usage>[3] = {}) {
	const said: [string, ActorUsage][] = [];
	const it = new Usage(
		async (actor, usage) => {
			said.push([actor, usage]);
			if (refuse) throw new Error('badRequest');
		},
		() => actors,
		() => {},
		options,
	);
	return { it, said, last: (actor: string) => said.findLast(([who]) => who === actor)?.[1] };
}

/** A running Claude Code counting the times it is asked for `/usage`, each answer taking `ms`. */
function counting(answer: () => object | Error = () => pulled, ms = 0) {
	const it = { pulls: 0 };
	const query = {
		accountInfo: async () => max,
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
			it.pulls++;
			await Bun.sleep(ms);
			const usage = answer();
			if (usage instanceof Error) throw usage;
			return usage;
		},
	};
	return Object.assign(it, { query: query as never });
}

/** A running Claude Code answering as `account` and `usage` say, or failing. */
const running = (account: object | Error, usage: object | Error = pulled) =>
	({
		accountInfo: async () => {
			if (account instanceof Error) throw account;
			return account;
		},
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
			if (usage instanceof Error) throw usage;
			return usage;
		},
	}) as never;
const max = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' } as const;

test("a rate limit event's fractions and the windows beside it become plan limits", () => {
	expect([...rateLimitLimits(event).values()]).toEqual([
		{ label: '5-hour limit', used: 0.41, resets_at: 1793293200 },
		{ label: 'Weekly limit', used: 0.15, resets_at: 1793732400 },
	]);
	// Overage isn't a plan window.
	expect(rateLimitLimits({ status: 'allowed', rateLimitType: 'overage', utilization: 0.5 }).size).toBe(0);
});

test("/usage's percentages and ISO times become plan limits, leaving out what isn't a window", () => {
	expect([...pulledLimits(pulled)!.values()]).toEqual([
		{ label: '5-hour limit', used: 0.41, resets_at: 1793293200 },
		{ label: 'Weekly limit', used: 0.16, resets_at: 1793732400 },
		{ label: 'Weekly Fable limit', used: 0, resets_at: 1793732400 },
	]);
	expect(pulledLimits({ ...pulled, rate_limits_available: false, rate_limits: null })).toBeNull();
});

test('limits read as words', () => {
	expect(label('seven_day_sonnet')).toBe('Weekly Sonnet limit');
	expect(label('seven_day_cowork')).toBe('Weekly Cowork limit');
	expect(label('seven_day_overage_included')).toBeNull();
	expect(label('amber_ladder')).toBeNull();
});

test("a turn's context counts every input and output token against the window", () => {
	const usage = { input_tokens: 2, cache_creation_input_tokens: 15_021, cache_read_input_tokens: 1000, output_tokens: 4 };
	expect(liveContext(usage, 200_000)).toEqual({ used_tokens: 16_027, total_tokens: 200_000 });
	expect(liveContext(usage, null)).toBeNull();
});

test('every actor says the last known value of each limit, as sparse events change one', async () => {
	const { it, last } = usage();
	await it.pull(running(max), true);
	it.rateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 1793293200 });
	for (const actor of ['a', 'b']) {
		expect(last(actor)?.plan?.map((limit) => [limit.label, limit.used])).toEqual([
			['5-hour limit', 0.9],
			['Weekly limit', 0.16],
			['Weekly Fable limit', 0],
		]);
	}
});

test('every actor says the plan, and says nothing unchanged again', () => {
	const { it, said, last } = usage();
	it.rateLimit(event);
	expect(last('a')).toEqual({ plan: last('b')!.plan! });
	const count = said.length;
	it.rateLimit(event);
	expect(said.length).toBe(count);
});

test("every actor names the account's pool once it is known", async () => {
	const { it, last } = usage();
	it.rateLimit(event);
	expect(last('a')?.pool).toBeUndefined();
	await it.pull(running({ ...max, email: 'me@example.com' }), true);
	for (const actor of ['a', 'b']) {
		expect(last(actor)?.pool).toEqual({ id: 'claude:me@example.com', name: 'me@example.com' });
	}
});

test("an account's pool is its email, within its organization, and none without a plan", () => {
	expect(poolOf({ ...max, email: 'me@example.com', organization: 'Acme' })).toEqual({ id: 'claude:me@example.com/Acme', name: 'me@example.com' });
	expect(poolOf(max)).toBeNull();
	expect(poolOf({ apiProvider: 'bedrock', email: 'me@example.com' })).toBeNull();
	expect(poolOf({ ...max, email: `${'x'.repeat(130)}@example.com` })).toBeNull();
});

test('an API-key, Bedrock or Vertex session says no plan', async () => {
	for (const account of [{ apiProvider: 'firstParty', apiKeySource: 'user' }, { apiProvider: 'bedrock' }]) {
		const { it, said } = usage();
		await it.pull(running(account, { ...pulled, rate_limits_available: false, rate_limits: null }), true);
		it.rateLimit(event);
		expect(said).toEqual([]);
	}
});

test("Claude Code's failures and cohesiond's refusals are swallowed, keeping what events said", async () => {
	const { it, last } = usage(['a'], true);
	it.rateLimit(event);
	await it.pull(running(new Error('gone'), new Error('no such method')), true);
	expect(last('a')?.plan).toHaveLength(2);
	await Bun.sleep(0);
});

test('at most eight limits, each label at most 64 bytes', () => {
	const { it, last } = usage(['a']);
	const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`seven_day_${'x'.repeat(70)}${String.fromCharCode(97 + i)}`, { utilization: 0.1 }]));
	it.rateLimit({ status: 'allowed', unifiedWindows: many } as unknown as SDKRateLimitInfo);
	expect(last('a')?.plan).toHaveLength(8);
	for (const limit of last('a')!.plan!) expect(new TextEncoder().encode(limit.label).length).toBeLessThanOrEqual(64);
});

test("a session says its rate limit events, its live context, and its context after each turn, failing or not", async () => {
	const { handle, usages, contexts, sent } = session();
	await handle({ type: 'rate_limit_event', rate_limit_info: event });
	expect(usages.at(-1)?.plan).toHaveLength(2);
	const query = {
		getContextUsage: async () => ({ totalTokens: 17_336, maxTokens: 1_000_000 }),
		accountInfo: async () => max,
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => pulled,
	};
	const result = { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000 } } };
	await handle(result, { query });
	await Bun.sleep(0);
	expect(usages.at(-1)).toEqual({ plan: [...pulledLimits(pulled)!.values()] });
	expect(contexts().at(-1)).toEqual({ used_tokens: 17_336, total_tokens: 1_000_000 });
	// Live during the next turn, against the window the last one measured.
	await handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 20_000, output_tokens: 10 } } });
	expect(contexts().at(-1)).toEqual({ used_tokens: 20_010, total_tokens: 1_000_000 });
	// /context failing falls back to the result's window and leaves the session be.
	await handle(result, { query: { ...query, getContextUsage: async () => Promise.reject(new Error('gone')) } });
	await Bun.sleep(0);
	expect(sent.filter((report) => report.kind === 'status')).toEqual([]);
});

const step = (usage: Record<string, number>, ...tools: string[]) => ({
	type: 'assistant',
	parent_tool_use_id: null,
	message: { content: tools.map((name, i) => ({ type: 'tool_use', id: `${name}${i}`, name, input: { command: 'ls' } })), usage },
});
const counted = (totalTokens: number) => ({ getContextUsage: async () => ({ totalTokens, maxTokens: 200_000 }) });

test("a session's first turn moves the ring: the window is learned when Claude Code starts", async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: counted(15_000) });
	await Bun.sleep(0);
	expect(contexts().at(-1)).toEqual({ used_tokens: 15_000, total_tokens: 200_000 });
	await handle(step({ input_tokens: 18_000, output_tokens: 5 }), { query: counted(0) });
	expect(contexts().at(-1)).toEqual({ used_tokens: 18_005, total_tokens: 200_000 });
});

test('Claude Code failing to count at its start leaves the session be', async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: { getContextUsage: async () => Promise.reject(new Error('gone')) } });
	await handle({ type: 'system', subtype: 'init' }, { query: {} });
	await Bun.sleep(0);
	expect(contexts()).toEqual([]);
});

test('compaction drops the live context to what it left', async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: counted(150_000) });
	await Bun.sleep(0);
	await handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 12_000 } });
	expect(contexts().at(-1)).toEqual({ used_tokens: 12_000, total_tokens: 200_000 });
	// Without what it left, nothing is said.
	const count = contexts().length;
	await handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12_000 } });
	expect(contexts()).toHaveLength(count);
});

test("a step using tools is counted again by /context mid-turn, the step's own count standing when it fails", async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: counted(10_000) });
	await Bun.sleep(0);
	await handle(step({ input_tokens: 20_000 }, 'Bash'), { query: counted(23_000) });
	await Bun.sleep(0);
	expect(contexts().map((context) => context.used_tokens)).toEqual([10_000, 20_000, 23_000]);
	// A step without tools isn't counted again.
	await handle(step({ input_tokens: 24_000 }), { query: counted(99_000) });
	await Bun.sleep(0);
	expect(contexts().at(-1)?.used_tokens).toBe(24_000);
	await handle(step({ input_tokens: 25_000 }, 'Bash'), { query: { getContextUsage: async () => Promise.reject(new Error('gone')) } });
	await Bun.sleep(0);
	expect(contexts().at(-1)?.used_tokens).toBe(25_000);
	// Nor is one whose Claude Code has ended.
	let asked = false;
	await handle(step({ input_tokens: 26_000 }, 'Bash'), { closed: true, query: { getContextUsage: async () => ((asked = true), { totalTokens: 1, maxTokens: 200_000 }) } });
	await Bun.sleep(0);
	expect(asked).toBe(false);
	expect(contexts().at(-1)?.used_tokens).toBe(26_000);
});

test('only the latest mid-turn count is said, whatever order they come back in', async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: counted(10_000) });
	await Bun.sleep(0);
	const answers: ((totalTokens: number) => void)[] = [];
	const query = { getContextUsage: () => new Promise((resolve) => answers.push((totalTokens) => resolve({ totalTokens, maxTokens: 200_000 }))) };
	await handle(step({ input_tokens: 20_000 }, 'Bash'), { query });
	await handle(step({ input_tokens: 30_000 }, 'Bash'), { query });
	answers[1]!(33_000);
	await Bun.sleep(0);
	answers[0]!(22_000);
	await Bun.sleep(0);
	expect(contexts().at(-1)?.used_tokens).toBe(33_000);
	// One under way when a newer step says its own count is stale too.
	await handle(step({ input_tokens: 40_000 }, 'Bash'), { query });
	await handle(step({ input_tokens: 41_000 }), { query });
	answers[2]!(44_000);
	await Bun.sleep(0);
	expect(contexts().at(-1)?.used_tokens).toBe(41_000);
});

test("a subagent's steps say nothing", async () => {
	const { handle, contexts } = session();
	await handle({ type: 'system', subtype: 'init' }, { query: counted(10_000) });
	await Bun.sleep(0);
	let asked = false;
	await handle({ ...step({ input_tokens: 90_000 }, 'Bash'), parent_tool_use_id: 'a' }, { query: { getContextUsage: async () => ((asked = true), {}) } });
	await Bun.sleep(0);
	expect(asked).toBe(false);
	expect(contexts().at(-1)?.used_tokens).toBe(10_000);
});

test('a pull just after another is skipped, but one after a turn always asks', async () => {
	const { it } = usage(['a'], false, { gap: 60_000 });
	const claude = counting();
	await it.pull(claude.query);
	await it.pull(claude.query);
	expect(claude.pulls).toBe(1);
	await it.pull(claude.query, true);
	await it.pull(claude.query, true);
	expect(claude.pulls).toBe(3);
});

test('pulls at once are one, and a turn ending during one asks again after it', async () => {
	const { it } = usage(['a'], false, { gap: 0 });
	const claude = counting(() => pulled, 20);
	const first = it.pull(claude.query);
	await Promise.all([first, it.pull(claude.query), it.pull(claude.query, true), it.pull(claude.query, true)]);
	expect(claude.pulls).toBe(2);
});

test("a pull answered from Claude Code's cache, without the per-model limits, keeps them", async () => {
	const { it, last } = usage(['a']);
	await it.pull(running(max), true);
	const { model_scoped: _, ...short } = pulled.rate_limits!;
	const cached = { ...pulled, rate_limits: { ...short, five_hour: { utilization: 42, resets_at: '2026-10-29T16:59:59.953533+00:00' } } } as never;
	expect([...pulledLimits(cached)!.keys()]).not.toContain('model:Fable');
	await it.pull(running(max, cached), true);
	expect(last('a')?.plan?.map((limit) => [limit.label, limit.used])).toEqual([
		['5-hour limit', 0.42],
		['Weekly limit', 0.16],
		['Weekly Fable limit', 0],
	]);
});
