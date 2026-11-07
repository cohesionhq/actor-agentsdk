// Between Claude Code's tools and Cohesion's transcript: what a tool use
// shows as, the request a permission prompt becomes, and what the user's
// response tells Claude Code.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import type { CanUseTool, PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
	ActorSaidContent,
	ActorPermissionDecision,
	ActorPermissionSubject,
	ActorQuestion,
	ActorToolKind,
	ActorUserContent,
} from 'cohesion-ts';

type Input = Record<string, unknown>;
type PromptOptions = Parameters<CanUseTool>[2];

/** The tools whose permission prompt is a question for the user rather than leave to act. */
export const QUESTION_TOOL = 'AskUserQuestion';
export const PLAN_TOOL = 'ExitPlanMode';

/** The mode a session leaves plan mode for once its plan is approved. */
export const AFTER_PLAN: PermissionMode = 'auto';

const string = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A tool use as the transcript shows it: the tool, its kind, and what it did in a line. */
export function toolUse(name: string, input: Input, cwd: string): Extract<ActorSaidContent, { kind: 'toolUse' }> {
	return { kind: 'toolUse', tool: displayName(name), category: category(name), summary: summary(name, input, cwd) };
}

const CATEGORIES: Record<string, ActorToolKind> = {
	Bash: 'command',
	BashOutput: 'command',
	KillShell: 'command',
	KillBash: 'command',
	Read: 'read',
	NotebookRead: 'read',
	LS: 'read',
	Edit: 'edit',
	MultiEdit: 'edit',
	Write: 'edit',
	NotebookEdit: 'edit',
	Grep: 'search',
	Glob: 'search',
	WebFetch: 'web',
	WebSearch: 'web',
	Agent: 'agent',
	Task: 'agent',
	Skill: 'skill',
};

/**
 * What kind of tool `name` is, for the icon Cohesion shows. MCP tools and any
 * name not known here are `other`.
 */
export function category(name: string): ActorToolKind {
	return Object.hasOwn(CATEGORIES, name) ? CATEGORIES[name]! : 'other';
}

/**
 * Tool `name` as the user reads it: an MCP tool, `mcp__<server>__<tool>`,
 * becomes "Server: tool", such as "Gmail: search threads" for
 * `mcp__claude_ai_Gmail__search_threads`. Only for showing; Claude Code
 * still knows the tool by `name`.
 */
export function displayName(name: string): string {
	if (!name.startsWith('mcp__')) return name;
	const rest = name.slice('mcp__'.length);
	const split = rest.indexOf('__');
	const words = (text: string) => text.replace(/[_\-\s]+/g, ' ').trim();
	const server = words((split < 0 ? rest : rest.slice(0, split)).replace(/^claude_ai_/, ''));
	const tool = split < 0 ? '' : words(rest.slice(split + 2));
	const shown = server && server[0]!.toUpperCase() + server.slice(1);
	if (shown && tool) return `${shown}: ${tool}`;
	return shown || tool || name;
}

function summary(name: string, input: Input, cwd: string): string {
	const path = string(input.file_path) ?? string(input.notebook_path) ?? string(input.path);
	switch (name) {
		case 'Bash':
			// Claude Code's own words for the command, as its CLI shows it.
			return line(string(input.description) ?? string(input.command) ?? '');
		case 'Read':
		case 'Edit':
		case 'Write':
		case 'NotebookEdit':
			return path ? shown(path, cwd) : '';
		case 'Grep':
		case 'Glob':
			return line(string(input.pattern) ?? '');
		case 'WebFetch':
			return string(input.url) ?? '';
		case 'WebSearch':
			return string(input.query) ?? '';
		case 'Agent':
		case 'Task':
			return string(input.description) ?? '';
		case 'Skill':
			// Not typed by the SDK: `{ skill, args? }`, as the model calls it.
			return line([string(input.skill), string(input.args)].filter(Boolean).join(' '));
		default:
			return line(Object.values(input).find((value) => typeof value === 'string') ?? '');
	}
}

/** What the actor is doing while a tool runs, for the task's activity. */
export function progress(name: string, input: Input, cwd: string): string {
	const about = summary(name, input, cwd);
	const verb: Record<string, string> = {
		Bash: 'Running',
		Read: 'Reading',
		Edit: 'Editing',
		Write: 'Writing',
		NotebookEdit: 'Editing',
		Grep: 'Searching for',
		Glob: 'Looking for',
		WebFetch: 'Reading',
		WebSearch: 'Searching the web for',
		Skill: 'Running skill',
	};
	if (name === 'Agent' || name === 'Task') return about || 'Working with a subagent';
	if (name === 'Bash' && string(input.description)) return about;
	return verb[name] && about ? `${verb[name]} ${about}` : `Using ${displayName(name)}`;
}

/** The request a permission prompt for tool `name` becomes. */
export function request(name: string, input: Input, options: PromptOptions, cwd: string): ActorSaidContent {
	if (name === QUESTION_TOOL) return { kind: 'question', questions: questions(input) };
	if (name === PLAN_TOOL) return { kind: 'plan', plan: string(input.plan) ?? '' };
	const decisions: ActorPermissionDecision[] = ['allow'];
	if (options.suggestions?.length && !options.suppressAlwaysAllowRule) decisions.push('allowForSession');
	decisions.push('deny', 'abort');
	return {
		kind: 'permission',
		subject: subject(name, input, cwd),
		reason: string(input.description) ?? options.decisionReason ?? null,
		decisions,
	};
}

function questions(input: Input): ActorQuestion[] {
	const asked = (input.questions ?? []) as { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
	return asked.map((question) => ({
		header: question.header ?? null,
		question: question.question,
		options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? null })),
		multi_select: question.multiSelect ?? false,
		// Claude Code always offers an answer in the user's own words.
		allows_other: true,
	}));
}

function subject(name: string, input: Input, cwd: string): ActorPermissionSubject {
	const path = string(input.file_path) ?? string(input.notebook_path);
	switch (name) {
		case 'Bash':
			return { kind: 'command', command: string(input.command) ?? '', cwd };
		case 'Edit':
			return path ? fileChange(path, cwd, 'update', editDiff(path, cwd, input)) : tool(name, input);
		case 'Write': {
			if (!path) return tool(name, input);
			const before = readOrNull(path);
			return fileChange(path, cwd, before === null ? 'add' : 'update', diff(shown(path, cwd), before, string(input.content) ?? ''));
		}
		case 'NotebookEdit':
			return path ? fileChange(path, cwd, 'update', null) : tool(name, input);
		default:
			return tool(name, input);
	}
}

// The name is only shown: the response is matched to the prompt, not to it.
const tool = (name: string, input: Input): ActorPermissionSubject => ({ kind: 'tool', name: displayName(name), input });

function fileChange(path: string, cwd: string, change: 'add' | 'update', diff: string | null): ActorPermissionSubject {
	return { kind: 'fileChange', changes: [{ path: shown(path, cwd), change, diff }] };
}

/** What the user's response to the prompt for tool `name` with `input` tells Claude Code. */
export function result(name: string, input: Input, options: PromptOptions, response: ActorUserContent): PermissionResult {
	switch (response.kind) {
		case 'answers': {
			const asked = questions(input);
			const answers = Object.fromEntries(
				asked.map((question, index) => {
					const answer = response.answers[index];
					const picked = [...(answer?.selected ?? []), ...(answer?.other ? [answer.other] : [])];
					return [question.question, picked.join(', ')];
				}),
			);
			return { behavior: 'allow', updatedInput: { ...input, answers } };
		}
		case 'plan':
			if (response.approved) {
				return {
					behavior: 'allow',
					updatedInput: input,
					updatedPermissions: [{ type: 'setMode', mode: AFTER_PLAN, destination: 'session' }],
				};
			}
			return {
				behavior: 'deny',
				message: response.feedback
					? `The user didn't approve the plan. Their feedback: ${response.feedback}`
					: "The user didn't approve the plan.",
			};
		case 'permission':
			switch (response.decision) {
				case 'allow':
					return { behavior: 'allow', updatedInput: input };
				case 'allowForSession':
					return {
						behavior: 'allow',
						updatedInput: input,
						// For this session only: never written to settings files.
						updatedPermissions: (options.suggestions ?? []).map((update) => ({ ...update, destination: 'session' })),
					};
				case 'deny':
				case 'abort':
					return {
						behavior: 'deny',
						message: response.message ? `The user said no: ${response.message}` : 'The user said no.',
						interrupt: response.decision === 'abort',
					};
			}
		case 'text':
			// Words in place of a response: the user passed over the request.
			return { behavior: 'deny', message: `The user didn't respond to this, and said instead: ${response.text}` };
	}
}

/**
 * What the user said, as words: a response to a request no longer waiting
 * (its Claude Code process ended) is handed over as text.
 */
export function describe(response: ActorUserContent): string {
	switch (response.kind) {
		case 'text':
			return response.text;
		case 'answers':
			return `My answers to your earlier questions: ${response.answers
				.map((answer) => [...answer.selected, ...(answer.other ? [answer.other] : [])].join(', '))
				.join('; ')}`;
		case 'permission':
			return `About your earlier request: ${response.decision === 'allow' || response.decision === 'allowForSession' ? 'go ahead' : 'no'}.${response.message ? ` ${response.message}` : ''}`;
		case 'plan':
			return response.approved
				? 'I approve your plan; go ahead.'
				: `I don't approve your plan.${response.feedback ? ` ${response.feedback}` : ''}`;
	}
}

/** `path` relative to the actor's directory when it is inside it. */
function shown(path: string, cwd: string): string {
	const inside = relative(cwd, path);
	return isAbsolute(path) && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
}

function line(text: string): string {
	const first = text.split('\n')[0] ?? '';
	return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

function readOrNull(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, 'utf8') : null;
	} catch {
		return null;
	}
}

/** An `Edit` as a unified diff, placed where `old_string` first appears. */
function editDiff(path: string, cwd: string, input: Input): string | null {
	const before = string(input.old_string);
	const after = string(input.new_string);
	if (before === null || after === null) return null;
	const contents = readOrNull(path) ?? '';
	const at = Math.max(contents.indexOf(before), 0);
	const start = contents.slice(0, at).split('\n').length;
	const removed = before.split('\n');
	const added = after.split('\n');
	const name = shown(path, cwd);
	return [
		`--- a/${name}`,
		`+++ b/${name}`,
		`@@ -${start},${removed.length} +${start},${added.length} @@`,
		...removed.map((text) => `-${text}`),
		...added.map((text) => `+${text}`),
	].join('\n');
}

/** A whole-file change as a unified diff: every old line out, every new line in. */
function diff(name: string, before: string | null, after: string): string {
	const removed = before === null || before === '' ? [] : before.replace(/\n$/, '').split('\n');
	const added = after === '' ? [] : after.replace(/\n$/, '').split('\n');
	return [
		before === null ? '--- /dev/null' : `--- a/${name}`,
		`+++ b/${name}`,
		`@@ -${removed.length ? 1 : 0},${removed.length} +${added.length ? 1 : 0},${added.length} @@`,
		...removed.map((text) => `-${text}`),
		...added.map((text) => `+${text}`),
	].join('\n');
}
