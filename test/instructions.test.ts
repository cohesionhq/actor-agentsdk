import { expect, test } from 'bun:test';

import { COHESION_INSTRUCTIONS } from '../src/instructions.ts';

test('tells Claude Code Cohesion renders mermaid blocks', () => {
	expect(COHESION_INSTRUCTIONS).toContain('`mermaid`');
	expect(COHESION_INSTRUCTIONS).toContain('plain code block');
});
