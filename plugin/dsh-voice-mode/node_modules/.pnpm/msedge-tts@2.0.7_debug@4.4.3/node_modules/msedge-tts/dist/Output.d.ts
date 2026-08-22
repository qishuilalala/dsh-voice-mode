/**
 * Only a few of the [possible formats](https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/rest-text-to-speech#audio-outputs) are accepted.
 */
export declare enum OUTPUT_FORMAT {
    AUDIO_24KHZ_48KBITRATE_MONO_MP3 = "audio-24khz-48kbitrate-mono-mp3",
    AUDIO_24KHZ_96KBITRATE_MONO_MP3 = "audio-24khz-96kbitrate-mono-mp3",
    WEBM_24KHZ_16BIT_MONO_OPUS = "webm-24khz-16bit-mono-opus"
}
export declare const OUTPUT_EXTENSIONS: {
    "audio-24khz-48kbitrate-mono-mp3": string;
    "audio-24khz-96kbitrate-mono-mp3": string;
    "webm-24khz-16bit-mono-opus": string;
};
