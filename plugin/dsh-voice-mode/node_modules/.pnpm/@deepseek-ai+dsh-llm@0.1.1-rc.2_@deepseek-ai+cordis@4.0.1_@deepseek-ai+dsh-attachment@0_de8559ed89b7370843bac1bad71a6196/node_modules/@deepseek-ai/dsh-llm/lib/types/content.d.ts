/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */
import type { ContentBlock } from './types.ts';
import type { Message } from './message.ts';
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
/** Model-facing stand-in for an image removed to fit a provider request bound. */
export declare const OFFLOADED_IMAGE_TEXT = "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]";
/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable master reference omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export declare function textOnlyImageText(ref: ImageAttachmentRef): string;
/**
 * Stable model-facing handle for one exact request image.
 * @param version - exact request image shown beside the text.
 * @returns attachment handle and request-image dimensions.
 */
export declare function requestImageHandleText(version: RequestImageAttachment): string;
/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export declare function contentHasImage(content: readonly ContentBlock[]): boolean;
/** Byte accounting and quantized removal policy for one request representation. */
export interface RequestImageOffloadPolicy {
    /** Image count accepted by the route; omission leaves count unbounded. */
    maxImages?: number;
    /** Accumulated image bytes accepted by the route; omission leaves bytes unbounded. */
    maxBytes?: number;
    /** Number of excess images removed as one deterministic step. */
    countQuantum?: number;
    /** Number of excess bytes removed as one deterministic step. */
    byteQuantum?: number;
    /** Whether byte accounting uses raw file bytes or inline base64 length. */
    representation: 'raw' | 'base64';
    /** Resolve the encoded request-version length; omission uses master attachment bytes. */
    byteLength?: (ref: ImageAttachmentRef) => number;
}
/**
 * Project durable image history into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export declare function projectImagesForTextModel(messages: readonly Message[]): readonly Message[];
/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata; a
 * provider can serialize the returned messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export declare function offloadRequestImages(messages: readonly Message[], maxRequestImageBytes: number | undefined): readonly Message[];
/**
 * Return a deterministic transient projection whose oldest images are replaced
 * in whole count and byte quanta after a route budget is exceeded. The target
 * depends only on complete durable history: at 129 one-megabyte images under
 * a 128 MiB bound with a 64 MiB quantum, the oldest 65 images are removed so
 * 64 MiB remain; that removed prefix stays fixed until total history exceeds
 * 192 MiB.
 * @param messages - complete request history, oldest first.
 * @param policy - route representation, budgets, and removal quanta.
 * @returns original messages below both bounds, otherwise shallow copies with deterministic placeholders.
 */
export declare function offloadRequestImagesWithPolicy(messages: readonly Message[], policy: RequestImageOffloadPolicy): readonly Message[];
//# sourceMappingURL=content.d.ts.map