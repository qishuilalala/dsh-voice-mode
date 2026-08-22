/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */
import { Service } from '@deepseek-ai/cordis';
import { AttachmentError } from "./error.js";
export { AttachmentId, ImageVariantId } from "./brand.js";
export { AttachmentError, isImageAdmissionError } from "./error.js";
export { admitEncodedImages } from "./admission.js";
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export class AttachmentStore extends Service {
    constructor(ctx) {
        super(ctx, 'attachments');
    }
    /**
     * Validate one ordered image batch before committing any member.
     * Validation failures start no writes; storage failures return no partial
     * references, although already published content-addressed objects may stay
     * unreachable until a future retention policy collects them.
     * @param inputs - encoded images in their owning message order.
     * @returns durable references in the exact input order.
     */
    validateImageBatch(inputs) {
        const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits;
        if (inputs.length > maxImagesPerMessage) {
            throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES');
        }
        const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0);
        if (totalBytes > maxMessageImageBytes) {
            throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE');
        }
        for (const input of inputs) {
            if (!mediaTypes.includes(input.mediaType)) {
                throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE');
            }
        }
    }
    /**
     * Validate and durably commit one ordered image batch.
     * @param inputs - encoded images in owning-message order.
     * @returns durable normalized attachment references in the same order after every member succeeds.
     */
    async saveImages(inputs) {
        this.validateImageBatch(inputs);
        for (const input of inputs)
            await this.validateImage(input);
        const refs = [];
        for (const input of inputs)
            refs.push(await this.saveImage(input));
        return refs;
    }
    /**
     * Generate or read one deterministic model-request version from the stored normalized image.
     * @param ref - durable provider-independent normalized attachment reference.
     * @param policy - exact route pixel and encoded-byte budget.
     * @param signal - optional cancellation.
     * @returns request bytes and the cache/upload identity covering every transform input.
     */
    readImageRequest(ref, policy, signal) {
        signal?.throwIfAborted();
        void ref;
        void policy;
        return Promise.reject(new AttachmentError('The mounted attachment provider cannot derive model-request images.', 'ATTACHMENT_PROJECTION_UNSUPPORTED'));
    }
}
export default AttachmentStore;
//# sourceMappingURL=index.js.map