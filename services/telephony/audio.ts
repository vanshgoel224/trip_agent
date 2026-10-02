// Telephony audio helpers: 16-bit signed little-endian mono PCM ("slin").

export const RATE = 8000;

/** RMS energy of a PCM16 frame. */
export function rms(pcm: Buffer) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Linear-interpolation resample of PCM16 mono. Good enough for 8 kHz phone audio. */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const inN = Math.floor(pcm.length / 2);
  const outN = Math.floor((inN * to) / from);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * from) / to;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, inN - 1);
    const f = x - i0;
    const v = pcm.readInt16LE(i0 * 2) * (1 - f) + pcm.readInt16LE(i1 * 2) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

/** Wrap PCM16 mono in a WAV container (for STT APIs that want a file). */
export function wav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Extract PCM16 mono from a WAV file (any rate), resampled to 8 kHz. Throws on non-PCM audio. */
export function wavToPcm8k(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, rate = 0, channels = 1, bits = 16, format = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (format !== 1 || bits !== 16) throw new Error(`WAV must be 16-bit PCM (got format ${format}, ${bits}-bit)`);
      let pcm = buf.subarray(body, Math.min(buf.length, body + size));
      if (channels > 1) {
        const n = Math.floor(pcm.length / (2 * channels));
        const mono = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) mono.writeInt16LE(pcm.readInt16LE(i * 2 * channels), i * 2);
        pcm = mono;
      }
      return resample(Buffer.from(pcm), rate, RATE);
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/**
 * Utterance detector: feed 8 kHz PCM chunks; returns a finished utterance after
 * `silenceMs` of quiet following at least `minSpeechMs` of speech (or at `maxMs`).
 */
export class Vad {
  private buf: Buffer[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;
  speaking = false;
  constructor(private o = { threshold: 600, silenceMs: 800, minSpeechMs: 250, maxMs: 15_000 }) {}
  push(chunk: Buffer): Buffer | undefined {
    const ms = (chunk.length / 2 / RATE) * 1000;
    const loud = rms(chunk) > this.o.threshold;
    if (loud) {
      this.speaking = true;
      this.speechMs += ms;
      this.silenceMs = 0;
    } else if (this.speaking) this.silenceMs += ms;
    if (this.speaking) {
      this.buf.push(chunk);
      this.totalMs += ms;
    }
    const done = this.speaking && ((this.silenceMs >= this.o.silenceMs && this.speechMs >= this.o.minSpeechMs) || this.totalMs >= this.o.maxMs);
    if (this.speaking && this.silenceMs >= this.o.silenceMs && this.speechMs < this.o.minSpeechMs) this.reset(); // a click, not speech
    if (!done) return undefined;
    const out = Buffer.concat(this.buf);
    this.reset();
    return out;
  }
  private reset() {
    this.buf = [];
    this.speechMs = this.silenceMs = this.totalMs = 0;
    this.speaking = false;
  }
}
