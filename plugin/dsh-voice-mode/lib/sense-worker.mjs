// src/sense-worker.ts
import { parentPort, workerData } from "node:worker_threads";
function createSenseWorkerClient(worker) {
  let counter = 0;
  const pending = /* @__PURE__ */ new Map();
  let dead = false;
  worker.on?.("message", (msg) => {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.ok) {
      p.resolve(null);
      return;
    }
    p.resolve(p.op === "create" ? true : msg.text ?? "");
  });
  worker.on?.("error", (e) => {
    dead = true;
    const err = new Error("sense worker error: " + String(e?.message ?? e));
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  worker.on?.("exit", () => {
    dead = true;
    const err = new Error("sense worker exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  const request = (op, samples) => {
    if (dead) return Promise.reject(new Error("sense worker dead"));
    const id = counter++;
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject });
      const msg = { id, op };
      if (samples) msg.samples = samples;
      try {
        worker.postMessage(msg);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };
  return {
    request,
    terminate: async () => {
      dead = true;
      const err = new Error("sense worker terminated");
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      try {
        await worker.terminate?.();
      } catch {
      }
    }
  };
}
function startSenseWorker(data) {
  const port = parentPort;
  if (!port) return;
  let recognizer = null;
  let sherpa = null;
  port.on("message", async (msg) => {
    try {
      if (msg.op === "create" || msg.op === "decode") {
        if (!sherpa) {
          sherpa = await import(data.sherpaModule);
        }
        if (!recognizer) {
          recognizer = sherpa.createOfflineRecognizer({
            featConfig: { sampleRate: 16e3, featureDim: 80 },
            modelConfig: {
              senseVoice: {
                model: data.modelDir + "/model.int8.onnx",
                language: "auto",
                useInverseTextNormalization: 1
              },
              tokens: data.modelDir + "/tokens.txt",
              provider: "cpu",
              debug: 0
            }
          });
        }
        if (msg.op === "decode" && msg.samples) {
          const stream = recognizer.createStream();
          try {
            stream.acceptWaveform(16e3, msg.samples);
            recognizer.decode(stream);
            const text = recognizer.getResult(stream).text.trim();
            port.postMessage({ id: msg.id, ok: true, text });
          } finally {
            try {
              stream.free();
            } catch {
            }
          }
          return;
        }
        port.postMessage({ id: msg.id, ok: true, text: "" });
        return;
      }
      port.postMessage({ id: msg.id, ok: false, error: "unknown op: " + msg.op });
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: String(e) });
    }
  });
}
if (parentPort) {
  startSenseWorker(workerData);
}
export {
  createSenseWorkerClient,
  startSenseWorker
};
