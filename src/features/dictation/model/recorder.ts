import { DICTATION_SAMPLE_RATE } from "./dictation";

export type DictationRecording = {
  /** Stops the microphone and resolves mono 16 kHz samples. */
  stop(): Promise<Float32Array>;
  /** Stops the microphone and drops the take. */
  cancel(): void;
};

async function toWhisperSamples(blob: Blob): Promise<Float32Array> {
  if (blob.size === 0) return new Float32Array();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    // A mono offline graph downmixes and resamples in one render.
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE)),
      DICTATION_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } finally {
    void context.close();
  }
}

export async function startDictationRecording(): Promise<DictationRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const release = () => stream.getTracks().forEach((track) => track.stop());
  recorder.start();
  const samples = () =>
    toWhisperSamples(new Blob(chunks, { type: recorder.mimeType }));
  return {
    stop: () => {
      // A recorder that stopped by itself (mic unplugged) never fires `stop` again.
      if (recorder.state === "inactive") {
        release();
        return samples();
      }
      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          release();
          samples().then(resolve, reject);
        };
        recorder.stop();
      });
    },
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state === "inactive") release();
      else recorder.stop();
    },
  };
}
