#!/usr/bin/env bun
// actor-agentsdk: offers Claude Code, in the directories it is given,
// to cohesiond as actors, and runs the actor sessions Cohesion hands them
// through the Claude Agent SDK. The command line and the run loop are
// cohesion-agent-kit's.

import { ActorService, loadConfig, runCli, SessionHost, SessionStore, stderrLog, type AppInfo } from 'cohesion-agent-kit';
import type { ActorModel } from 'cohesion-ts';

import { claudeCodeEngine } from './src/host.ts';
import { actorDefinitions, availableModels, PRODUCT } from './src/offers.ts';
import type { SessionRecord } from './src/session.ts';
import { Usage } from './src/usage.ts';

const app: AppInfo = { name: 'actor-agentsdk', product: PRODUCT };

process.exit(await runCli({ app, run }));

async function run(directory: string): Promise<void> {
	const log = stderrLog();
	const config = loadConfig(app, directory);
	let models: ActorModel[] = [];
	try {
		models = await availableModels();
	} catch (error) {
		log(`Couldn't list Agent SDK's models, so sessions run on its default: ${error instanceof Error ? error.message : error}`);
	}

	let actors = config.actors;
	const usage = new Usage(
		(actor, said) => host.client.usage(actor, said),
		() => actors.map((actor) => actor.identifier),
		log,
	);
	const store = new SessionStore<SessionRecord>(directory);
	const host = new SessionHost(config.actors, claudeCodeEngine(store, usage, log), store, log);
	const service = await ActorService.create({
		app,
		directory,
		config,
		host,
		offers: (config) => {
			actors = config.actors;
			return { actors: actorDefinitions(config.actors, models) };
		},
		// A new actor shares the plan's limits.
		afterOffer: () => usage.flush(),
		log,
	});
	// The plan's limits, now and every few minutes, sessions running or not.
	usage.start();
	await service.run();
	usage.stop();
}
