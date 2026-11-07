// Images between Claude Code and Cohesion: the user's go in as image content
// blocks, and the ones Claude Code shows (an image it read, a screenshot an
// MCP tool took) come back with the transcript message they belong to,
// checked with the kit's `sendable` against the rules cohesiond refuses a
// message for.

import type { ClientImage, MEDIA_TYPES } from 'cohesion-agent-kit';

export { sendable } from 'cohesion-agent-kit';

type MediaType = (typeof MEDIA_TYPES)[number];

/** An image as Claude takes it. */
export interface ImageBlock {
	type: 'image';
	source: { type: 'base64'; media_type: MediaType; data: string };
}

/** The images among Claude's content blocks, as Cohesion takes them; one by URL or file is skipped. */
export function imagesIn(content: unknown): ClientImage[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block): ClientImage[] => {
		if (block?.type === 'image') {
			const source = block.source;
			return source?.type === 'base64' && typeof source.data === 'string' ? [{ media_type: String(source.media_type), data: source.data }] : [];
		}
		// A tool's result holds its own blocks.
		if (block?.type === 'tool_result') return imagesIn(block.content);
		return [];
	});
}

/** The user's images, as Claude takes them. */
export function imageBlocks(images: ClientImage[]): ImageBlock[] {
	return images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.media_type as MediaType, data: image.data } }));
}

/** Whether a `Read` of `path` gives Claude Code an image. */
export function readsImage(path: string): boolean {
	return /\.(png|jpe?g|gif|webp)$/i.test(path);
}
