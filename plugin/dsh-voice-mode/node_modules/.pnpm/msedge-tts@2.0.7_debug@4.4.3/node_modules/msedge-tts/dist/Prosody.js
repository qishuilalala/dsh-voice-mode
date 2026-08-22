"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VOLUME = exports.PITCH = exports.RATE = exports.ProsodyOptions = void 0;
class ProsodyOptions {
    /**
     * The pitch to use.
     * Can be any {@link PITCH}, or a relative frequency in Hz (+50Hz), a relative semitone (+2st), or a relative percentage (+50%).
     * [SSML documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,pitch,-Indicates%20the%20baseline)
     */
    pitch = "+0Hz";
    /**
     * The rate to use.
     * Can be any {@link RATE}, or a relative number (0.5), or string with a relative percentage (+50%).
     * [SSML documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,rate,-Indicates%20the%20speaking)
     */
    rate = 1.0;
    /**
     * The volume to use.
     * Can be any {@link VOLUME}, or an absolute number (0, 100), a string with a relative number (+50), or a relative percentage (+50%).
     * [SSML documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,volume,-Indicates%20the%20volume)
     */
    volume = 100.0;
}
exports.ProsodyOptions = ProsodyOptions;
/**
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,rate,-Indicates%20the%20speaking
 */
var RATE;
(function (RATE) {
    RATE["X_SLOW"] = "x-slow";
    RATE["SLOW"] = "slow";
    RATE["MEDIUM"] = "medium";
    RATE["FAST"] = "fast";
    RATE["X_FAST"] = "x-fast";
    RATE["DEFAULT"] = "default";
})(RATE || (exports.RATE = RATE = {}));
/**
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,pitch,-Indicates%20the%20baseline
 */
var PITCH;
(function (PITCH) {
    PITCH["X_LOW"] = "x-low";
    PITCH["LOW"] = "low";
    PITCH["MEDIUM"] = "medium";
    PITCH["HIGH"] = "high";
    PITCH["X_HIGH"] = "x-high";
    PITCH["DEFAULT"] = "default";
})(PITCH || (exports.PITCH = PITCH = {}));
/**
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice#:~:text=Optional-,volume,-Indicates%20the%20volume
 */
var VOLUME;
(function (VOLUME) {
    VOLUME["SILENT"] = "silent";
    VOLUME["X_SOFT"] = "x-soft";
    VOLUME["SOFT"] = "soft";
    VOLUME["MEDIUM"] = "medium";
    VOLUME["LOUD"] = "loud";
    VOLUME["X_LOUD"] = "x-LOUD";
    VOLUME["DEFAULT"] = "default";
})(VOLUME || (exports.VOLUME = VOLUME = {}));
