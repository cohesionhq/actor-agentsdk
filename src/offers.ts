// The actors this client offers: one Claude Code per directory, each with
// Claude Code's permission modes and the models it can run.

import { homedir } from 'node:os';

import { query, type EffortLevel, type ModelInfo, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ActorEntry } from 'cohesion-agent-kit';
import type { ActorDefinition, ActorModel } from 'cohesion-ts';

export const PRODUCT = 'Agent SDK';

/** The modes offered, the first the default; each is a Claude Code permission mode. */
export const MODES: { identifier: PermissionMode; title: string; description: string }[] = [
	{ identifier: 'auto', title: 'Auto', description: 'A classifier approves or denies each action; asks only when unsure.' },
	{ identifier: 'default', title: 'Ask', description: 'Asks before editing files or running commands.' },
	{ identifier: 'acceptEdits', title: 'Accept edits', description: 'Edits files on its own; asks before running commands.' },
	{ identifier: 'plan', title: 'Plan', description: 'Plans first, and changes nothing until you approve.' },
	{ identifier: 'bypassPermissions', title: 'Bypass permissions', description: 'Runs every tool without asking.' },
];

const EFFORT_TITLES: Record<EffortLevel, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
};

export function actorDefinitions(actors: ActorEntry[], models: ActorModel[]): ActorDefinition[] {
	return actors.map(({ identifier, directory }) => ({
		identifier,
		product: PRODUCT,
		scope: directory,
		modes: MODES.map(({ identifier, title, description }) => ({ identifier, title, description })),
		models,
	}));
}

/**
 * The newest models Claude Code offers this account, in its order. Asking
 * starts Claude Code without a prompt; nothing is sent to a model.
 */
export async function availableModels(): Promise<ActorModel[]> {
	const idle = new Promise<never>(() => {});
	const probe = query({
		prompt: (async function* () {
			yield await idle;
		})(),
		options: { cwd: homedir() },
	});
	try {
		return newestModels(await probe.supportedModels()).map(actorModel);
	} finally {
		probe.close();
	}
}

/**
 * Claude Code's aliases, which always name the newest model of each family;
 * the pinned versions it also lists name themselves. An alias that repeats a
 * later one's model (`default` is Opus) is left out. A Claude Code that
 * doesn't say what its aliases resolve to has every model offered.
 */
export function newestModels(models: ModelInfo[]): ModelInfo[] {
	const aliases = models.filter((model) => model.resolvedModel !== undefined && model.resolvedModel !== model.value);
	if (aliases.length === 0) return models;
	return aliases.filter((model, index) => !aliases.slice(index + 1).some((later) => later.resolvedModel === model.resolvedModel));
}

function actorModel(model: ModelInfo): ActorModel {
	return {
		identifier: model.value,
		title: model.displayName,
		efforts: (model.supportedEffortLevels ?? []).map((level) => ({
			identifier: level,
			title: EFFORT_TITLES[level],
		})),
	};
}
