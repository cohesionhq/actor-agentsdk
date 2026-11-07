import { expect, test } from 'bun:test';

import { imagesIn } from '../src/images.ts';
import { session } from './fake_session.ts';

const png = (data = 'iVBORw0KGgo=') => ({ media_type: 'image/png', data });

test("images are read from Claude's blocks and a tool's result; ones by URL aren't", () => {
	const content = [
		{ type: 'text', text: 'Here.' },
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
		{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
		{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'BBBB' } }] },
	];
	expect(imagesIn(content)).toEqual([png('AAAA'), { media_type: 'image/webp', data: 'BBBB' }]);
	expect(imagesIn('just text')).toEqual([]);
});

const readImage = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/src/shot.png' } }] } };
const readResult = {
	type: 'user',
	parent_tool_use_id: null,
	message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
};

test("a Read of an image is reported once its result comes, with the image; images are left out when there are none", async () => {
	const { handle, messages } = session();
	await handle(readImage);
	expect(messages()).toEqual([]);
	await handle(readResult);
	expect(messages()).toEqual([{ kind: 'message', content: { kind: 'toolUse', tool: 'Read', category: 'read', summary: 'shot.png' }, images: [png('AAAA')] }]);
	await handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } });
	expect(messages()[1]).toEqual({ kind: 'message', content: { kind: 'text', text: 'Done.' } });
	expect('images' in messages()[1]!).toBe(false);
});

test('a message refused for its images is sent again without them, with a note', async () => {
	const { handle, messages } = session((report) => report.kind === 'message' && !!report.images);
	await handle(readImage);
	await handle(readResult);
	const sent = messages();
	expect(sent).toHaveLength(3);
	expect(sent[1]).toEqual({ kind: 'message', content: { kind: 'toolUse', tool: 'Read', category: 'read', summary: 'shot.png' } });
	expect(sent[2]).toMatchObject({ kind: 'message', content: { kind: 'text' } });
});
