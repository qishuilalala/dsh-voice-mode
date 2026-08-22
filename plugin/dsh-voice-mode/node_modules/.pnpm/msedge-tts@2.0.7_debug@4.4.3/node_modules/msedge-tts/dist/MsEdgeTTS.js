"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MsEdgeTTS = exports.MetadataOptions = void 0;
const axios_1 = __importDefault(require("axios"));
const isomorphic_ws_1 = __importDefault(require("isomorphic-ws"));
const index_1 = require("buffer/index"); // /index is important for browser compatibility
const Output_1 = require("./Output");
const stream_1 = require("stream");
const fs = __importStar(require("fs"));
const Prosody_1 = require("./Prosody");
const utils_1 = require("./utils");
class MetadataOptions {
    /**
     * (optional) any voice locale that is supported by the voice. See the list of all voices for compatibility. If not provided, the locale will be inferred from the `voiceName`.
     * Changing the voiceName will reset the voiceLocale.
     */
    voiceLocale;
    /**
     * (optional) whether to enable sentence boundary metadata. Default is `false`
     */
    sentenceBoundaryEnabled = false;
    /**
     * (optional) whether to enable word boundary metadata. Default is `false`
     */
    wordBoundaryEnabled = false;
}
exports.MetadataOptions = MetadataOptions;
var messageTypes;
(function (messageTypes) {
    messageTypes["TURN_START"] = "turn.start";
    messageTypes["TURN_END"] = "turn.end";
    messageTypes["RESPONSE"] = "response";
    messageTypes["SPEECH_CONFIG"] = "speech.config";
    messageTypes["AUDIO_METADATA"] = "audio.metadata";
    messageTypes["AUDIO"] = "audio";
    messageTypes["SSML"] = "ssml";
})(messageTypes || (messageTypes = {}));
class MsEdgeTTS {
    static TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    static VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${MsEdgeTTS.TRUSTED_CLIENT_TOKEN}`;
    static WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    static JSON_XML_DELIM = "\r\n\r\n";
    static AUDIO_DELIM = "Path:audio\r\n";
    static VOICE_LANG_REGEX = /\w{2}-\w{2}/;
    _enableLogger;
    _isBrowser;
    _ws;
    _voice;
    _outputFormat;
    _metadataOptions = new MetadataOptions();
    _streams = {};
    _startTime = 0;
    _agent;
    _log(...o) {
        if (this._enableLogger) {
            console.log(...o);
        }
    }
    /**
     * Create a new `MsEdgeTTS` instance.
     *
     * @param options (optional) {@link Options}
     */
    constructor(options) {
        this._agent = options?.agent || undefined;
        this._enableLogger = options?.enableLogger || false;
        this._isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
    }
    static async getSynthUrl() {
        const req_id = MsEdgeTTS.generateUUID(); // Generate the request ID
        const secMsGEC = await MsEdgeTTS.generateSecMsGec(this.TRUSTED_CLIENT_TOKEN);
        return `${this.WSS_URL}?TrustedClientToken=${this.TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGEC}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${req_id}`;
    }
    async _initClient() {
        const synthUrl = await MsEdgeTTS.getSynthUrl();
        const options = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            }
        };
        this._ws = this._isBrowser
            ? new isomorphic_ws_1.default(synthUrl, options)
            : new isomorphic_ws_1.default(synthUrl, { ...options, agent: this._agent });
        this._ws.binaryType = "arraybuffer";
        return new Promise((resolve, reject) => {
            this._ws.onopen = () => {
                this._log("Connected in", (Date.now() - this._startTime) / 1000, "seconds");
                this._send(`Content-Type:application/json; charset=utf-8\r\nPath:${messageTypes.SPEECH_CONFIG}${MsEdgeTTS.JSON_XML_DELIM}
                    {
                        "context": {
                            "synthesis": {
                                "audio": {
                                    "metadataoptions": {
                                        "sentenceBoundaryEnabled": "${this._metadataOptions.sentenceBoundaryEnabled}",
                                        "wordBoundaryEnabled": "${this._metadataOptions.wordBoundaryEnabled}"
                                    },
                                    "outputFormat": "${this._outputFormat}" 
                                }
                            }
                        }
                    }
                `).then(resolve);
            };
            this._ws.onmessage = (m) => {
                const buffer = index_1.Buffer.from(m.data);
                const message = buffer.toString();
                const requestId = /X-RequestId:(.*?)\r\n/gm.exec(message)[1];
                if (message.includes(`Path:${messageTypes.TURN_START}`)) {
                    // start of turn, ignore
                    this._log("->", message);
                }
                else if (message.includes(`Path:${messageTypes.TURN_END}`)) {
                    // end of turn, close stream
                    this._log("->", message);
                    this._streams[requestId].turnEnded = true;
                    this._streams[requestId].audio.push(null);
                }
                else if (message.includes(`Path:${messageTypes.RESPONSE}`)) {
                    // context response, ignore
                    this._log("->", message);
                }
                else if (message.includes(`Path:${messageTypes.AUDIO_METADATA}`)) {
                    // audio metadata, wordboundary/sentenceboundary
                    const dataStartIndex = buffer.indexOf(MsEdgeTTS.JSON_XML_DELIM) + MsEdgeTTS.JSON_XML_DELIM.length;
                    const data = buffer.subarray(dataStartIndex);
                    this._log("->", message);
                    this._pushMetadata(data, requestId);
                }
                else if (message.includes(`Path:${messageTypes.AUDIO}`) && m.data instanceof ArrayBuffer) {
                    const dataStartIndex = buffer.indexOf(MsEdgeTTS.AUDIO_DELIM) + MsEdgeTTS.AUDIO_DELIM.length;
                    const headers = buffer.subarray(0, dataStartIndex).toString();
                    const data = buffer.subarray(dataStartIndex);
                    this._log("->", headers);
                    this._pushAudioData(data, requestId);
                }
                else {
                    this._log("->", "UNKNOWN MESSAGE", message);
                }
            };
            this._ws.onclose = () => {
                this._log("disconnected after:", (Date.now() - this._startTime) / 1000, "seconds");
                for (const requestId in this._streams) {
                    const stream = this._streams[requestId];
                    if (stream.turnEnded) {
                        // synthesis finished normally, just close the stream
                        stream.audio.push(null);
                    }
                    else {
                        // socket closed before turn.end: the audio is truncated, so surface it as an
                        // error instead of silently ending the stream as if it were complete
                        stream.audio.destroy(new Error("Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated."));
                    }
                }
            };
            this._ws.onerror = (event) => {
                // Node's `ws` library fires either a native Error or an ErrorEvent wrapping one.
                const underlying = event?.error ?? event;
                const message = underlying?.message ?? String(underlying);
                const code = underlying?.code ?? event?.code;
                const wrapped = new Error(`Edge TTS WebSocket error: ${message}${code ? ` (code=${code})` : ""}`);
                wrapped.cause = underlying;
                reject(wrapped);
            };
        });
    }
    static generateUUID() {
        return 'xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    static async generateSecMsGec(trustedClientToken) {
        const ticks = Math.floor(Date.now() / 1000) + 11644473600;
        const rounded = ticks - (ticks % 300);
        const windowsTicks = rounded * 10000000;
        const encoder = new TextEncoder();
        const data = encoder.encode(`${windowsTicks}${trustedClientToken}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
    }
    async _send(message) {
        for (let i = 1; i <= 3 && this._ws.readyState !== this._ws.OPEN; i++) {
            if (i == 1) {
                this._startTime = Date.now();
            }
            this._log("connecting: ", i);
            await this._initClient();
        }
        this._ws.send(message, () => {
            this._log("<-", message);
        });
    }
    _pushAudioData(data, requestId) {
        this._streams[requestId].audio.push(data);
    }
    _pushMetadata(data, requestId) {
        this._streams[requestId].metadata.push(data);
    }
    _SSMLTemplate(input, options = {}) {
        // in case future updates to the edge API block these elements, we'll be concatenating strings.
        options = { ...new Prosody_1.ProsodyOptions(), ...options };
        return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${this._metadataOptions.voiceLocale}">
                <voice name="${this._voice}">
                    <prosody pitch="${options.pitch}" rate="${options.rate}" volume="${options.volume}">
                        ${input}
                    </prosody> 
                </voice>
            </speak>`;
    }
    /**
     * Fetch the list of voices available in Microsoft Edge.
     * These, however, are not all. The complete list of voices supported by this module [can be found here](https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support) (neural, standard, and preview).
     */
    getVoices() {
        return new Promise((resolve, reject) => {
            axios_1.default.get(MsEdgeTTS.VOICES_URL)
                .then((res) => resolve(res.data))
                .catch(reject);
        });
    }
    /**
     * Sets the required information for the speech to be synthesised and inits a new WebSocket connection.
     * Must be called at least once before text can be synthesised.
     * Saved in this instance. Can be called at any time times to update the metadata.
     * Merges specified values into previously provided values.
     *
     * @param voiceName a string with any `ShortName`. A list of all available neural voices can be found [here](https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support#neural-voices). However, it is not limited to neural voices: standard voices can also be used. A list of standard voices can be found [here](https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support#standard-voices). Changing the voiceName will reset the voiceLocale.
     * @param outputFormat any {@link OUTPUT_FORMAT}
     * @param metadataOptions (optional) {@link MetadataOptions}
     */
    async setMetadata(voiceName, outputFormat, metadataOptions) {
        const oldVoice = this._voice;
        const oldOutputFormat = this._outputFormat;
        const oldOptions = JSON.stringify(this._metadataOptions);
        this._voice = voiceName;
        if (!this._metadataOptions.voiceLocale || (!metadataOptions.voiceLocale && oldVoice !== this._voice)) {
            const voiceLangMatch = MsEdgeTTS.VOICE_LANG_REGEX.exec(this._voice);
            if (!voiceLangMatch)
                throw new Error("Could not infer voiceLocale from voiceName, and no voiceLocale was specified!");
            this._metadataOptions.voiceLocale = voiceLangMatch[0];
        }
        this._outputFormat = outputFormat;
        Object.assign(this._metadataOptions, metadataOptions);
        const changed = oldVoice !== this._voice
            || oldOutputFormat !== this._outputFormat
            || oldOptions !== JSON.stringify(this._metadataOptions);
        if (!changed && this._ws.readyState === this._ws.OPEN) {
            return;
        }
        // create new client
        this._startTime = Date.now();
        await this._initClient();
    }
    _metadataCheck() {
        if (!this._ws)
            throw new Error("Speech synthesis not configured yet. Run setMetadata before calling toStream or toFile.");
    }
    /**
     * Close the WebSocket connection.
     */
    close() {
        this._ws?.close();
    }
    /**
     * Writes raw audio synthesised from text to a file. Uses a basic {@link _SSMLTemplate SML template}.
     *
     * @param dirPath a valid output directory path
     * @param input the input to synthesise
     * @param options (optional) {@link ProsodyOptions}
     @returns {Promise<{audioFilePath: string, metadataFilePath: string | null}>} - a `Promise` with the full filepaths
     */
    toFile(dirPath, input, options) {
        return this._rawSSMLRequestToFile(dirPath, this._SSMLTemplate(input, options));
    }
    /**
     * Writes raw audio synthesised from text in real-time to a {@link Readable}. Uses a basic {@link _SSMLTemplate SML template}.
     *
     * @param input the text to synthesise. Can include SSML elements.
     * @param options (optional) {@link ProsodyOptions}
     @returns {Promise<{audioStream: Readable, metadataStream: Readable | null}>} - a `Promise` with the streams
     */
    toStream(input, options) {
        return this._rawSSMLRequest(this._SSMLTemplate(input, options));
    }
    /**
     * Writes raw audio synthesised from text to a file. Has no SSML template. Basic SSML should be provided in the request.
     *
     * @param dirPath a valid output directory path.
     * @param requestSSML the SSML to send. SSML elements required in order to work.
     * @returns {Promise<{audioFilePath: string, metadataFilePath: string | null}>} - a `Promise` with the full filepaths
     */
    rawToFile(dirPath, requestSSML) {
        return this._rawSSMLRequestToFile(dirPath, requestSSML);
    }
    /**
     * Writes raw audio synthesised from a request in real-time to a {@link Readable}. Has no SSML template. Basic SSML should be provided in the request.
     *
     * @param requestSSML the SSML to send. SSML elements required in order to work.
     @returns {Promise<{audioStream: Readable, metadataStream: Readable | null}>} - a `Promise` with the streams
     */
    rawToStream(requestSSML) {
        return this._rawSSMLRequest(requestSSML);
    }
    _hasMetadataBoundaries() {
        return this._metadataOptions.sentenceBoundaryEnabled
            || this._metadataOptions.wordBoundaryEnabled;
    }
    async _rawSSMLRequestToFile(dirPath, requestSSML) {
        const { audioStream, metadataStream, requestId } = this._rawSSMLRequest(requestSSML);
        const audioFilePath = (0, utils_1.joinPath)(dirPath, "audio." + Output_1.OUTPUT_EXTENSIONS[this._outputFormat]);
        const metadataFilePath = !!metadataStream ? (0, utils_1.joinPath)(dirPath, "metadata.json") : null;
        try {
            await Promise.all([
                new Promise((resolve, reject) => {
                    const writableAudioFile = audioStream.pipe(fs.createWriteStream(audioFilePath));
                    // .pipe() doesn't forward source errors to the writable, so a truncated stream
                    // would hang here — watch the audio stream directly and reject on its error
                    audioStream.once("error", (e) => {
                        writableAudioFile.destroy();
                        reject(e);
                    });
                    writableAudioFile.once("close", async () => {
                        if (writableAudioFile.bytesWritten > 0) {
                            resolve(audioFilePath);
                        }
                        else {
                            reject(new Error("No audio data received"));
                            fs.unlinkSync(audioFilePath);
                        }
                    });
                    writableAudioFile.once("error", reject);
                }),
                new Promise((resolve, reject) => {
                    if (!metadataFilePath) {
                        return resolve(null);
                    }
                    // get metadata from buffer and combine all MetaData root elements
                    const metadataItems = { Metadata: [] };
                    metadataStream.on("data", (chunk) => {
                        const chunkObj = JSON.parse(chunk.toString());
                        // .Metadata is an array of objects, just combine them
                        metadataItems.Metadata.push(...chunkObj["Metadata"]);
                    });
                    metadataStream.once("close", () => {
                        if (metadataItems.Metadata.length > 0) {
                            // create file if not exists
                            fs.writeFileSync(metadataFilePath, JSON.stringify(metadataItems, null, 2));
                            resolve(metadataFilePath);
                        }
                        else {
                            reject(new Error("No metadata received"));
                            fs.unlinkSync(metadataFilePath);
                        }
                    });
                    metadataStream.once("error", reject);
                }),
            ]);
            return { audioFilePath, metadataFilePath, requestId };
        }
        catch (e) {
            audioStream.destroy();
            metadataStream?.destroy();
            throw e;
        }
    }
    static randomHex(bytes) {
        const arr = new Uint8Array(bytes);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
    }
    _rawSSMLRequest(requestSSML) {
        this._metadataCheck();
        const requestId = MsEdgeTTS.randomHex(16);
        const request = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:${messageTypes.SSML}${MsEdgeTTS.JSON_XML_DELIM}` + requestSSML.trim();
        // https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/speech-synthesis-markup
        const self = this;
        const audioStream = new stream_1.Readable({
            read() {
            },
            destroy(error, callback) {
                delete self._streams[requestId];
                callback(error);
            },
        });
        const metadataStream = this._hasMetadataBoundaries() ? new stream_1.Readable({
            read() {
            },
        }) : null;
        audioStream.on("error", (e) => {
            audioStream.destroy();
            metadataStream?.destroy();
        });
        audioStream.once("close", () => {
            audioStream.destroy();
            metadataStream?.destroy();
        });
        this._streams[requestId] = {
            audio: audioStream,
            metadata: metadataStream,
            turnEnded: false,
        };
        this._send(request).then();
        return { audioStream, metadataStream, requestId };
    }
}
exports.MsEdgeTTS = MsEdgeTTS;
