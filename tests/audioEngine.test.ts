import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioEngine,
  AudioEngineHost,
  MIC_UNAVAILABLE_MESSAGE,
  microphoneErrorMessage,
} from "../VoiceLiveControl/audio/AudioEngine";
import { bufferToBase64 } from "../VoiceLiveControl/audio/pcm";

// ── Nachgebauter AudioContext: nur das, was die Wiedergabe braucht ──────

class FakeSource {
  buffer: { duration: number } | null = null;
  startAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {
    /* Graph wird nicht simuliert */
  }
  start(t: number) {
    this.startAt = t;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  closed = false;
  sources: FakeSource[] = [];
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume = vi.fn(async () => undefined);
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async close() {
    this.closed = true;
  }
}

/** Ein Chunk mit n Samples (24 kHz) als Base64. */
const chunk = (samples: number) => bufferToBase64(new Int16Array(samples).buffer);

let ctx: FakeContext;
let host: AudioEngineHost & { onPlaybackDrained: ReturnType<typeof vi.fn> };
let engine: AudioEngine;

/** Legt den Context an, ohne Mikrofon (das braucht einen Browser). */
async function withContext() {
  await (engine as unknown as { ensureAudioContext(): Promise<unknown> }).ensureAudioContext();
}

beforeEach(() => {
  ctx = new FakeContext();
  host = {
    log: vi.fn(),
    canSend: vi.fn(() => true),
    sendAudio: vi.fn(),
    onPlaybackDrained: vi.fn(),
  };
  engine = new AudioEngine(host, () => ctx as unknown as AudioContext);
});

afterEach(() => vi.restoreAllMocks());

describe("Wiedergabe", () => {
  it("spielt ohne Context nichts ab", () => {
    engine.play(chunk(2400));
    expect(engine.activeCount).toBe(0);
    expect(engine.remainingPlaybackMs).toBe(0);
  });

  it("legt den Context nur einmal an und registriert das Worklet einmal", async () => {
    await withContext();
    await withContext();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it("plant Chunks lückenlos hintereinander ein", async () => {
    await withContext();
    ctx.currentTime = 1;

    engine.play(chunk(2400)); // 0,1 s
    engine.play(chunk(4800)); // 0,2 s

    expect(ctx.sources.map((s) => s.startAt)).toEqual([1, 1.1]);
    expect(engine.activeCount).toBe(2);
    expect(engine.remainingPlaybackMs).toBeCloseTo(300);
  });

  it("startet nach einer Pause wieder bei jetzt", async () => {
    await withContext();
    engine.play(chunk(2400));
    ctx.currentTime = 5;
    engine.play(chunk(2400));
    expect(ctx.sources[1].startAt).toBe(5);
  });

  it("meldet das Ende erst, wenn der letzte Chunk verklungen ist", async () => {
    await withContext();
    engine.play(chunk(2400));
    engine.play(chunk(2400));

    ctx.sources[0].onended?.();
    expect(host.onPlaybackDrained).not.toHaveBeenCalled();
    expect(engine.activeCount).toBe(1);

    ctx.sources[1].onended?.();
    expect(host.onPlaybackDrained).toHaveBeenCalledOnce();
    expect(engine.activeCount).toBe(0);
  });

  it("stopPlayback stoppt alles und löst onended vorher", async () => {
    await withContext();
    engine.play(chunk(2400));
    engine.play(chunk(2400));

    engine.stopPlayback();

    expect(ctx.sources.every((s) => s.stopped && s.onended === null)).toBe(true);
    expect(engine.activeCount).toBe(0);
    expect(host.onPlaybackDrained).not.toHaveBeenCalled();
  });

  it("resetTimeline lässt die nächste Antwort sofort starten", async () => {
    await withContext();
    engine.play(chunk(24000)); // 1 s eingeplant
    engine.stopPlayback();
    engine.resetTimeline();
    expect(engine.remainingPlaybackMs).toBe(0);

    engine.play(chunk(2400));
    expect(ctx.sources[1].startAt).toBe(0);
  });

  it("dispose schließt den Context", async () => {
    await withContext();
    engine.dispose();
    expect(ctx.closed).toBe(true);
    engine.play(chunk(2400));
    expect(engine.activeCount).toBe(0);
  });
});

describe("Mikrofon", () => {
  it("meldet fehlendes getUserMedia", async () => {
    vi.stubGlobal("navigator", {});
    expect(await engine.startMicrophone()).toBe(MIC_UNAVAILABLE_MESSAGE);
    vi.unstubAllGlobals();
  });

  it("übersetzt Browser-Fehler in verständliche Meldungen", () => {
    expect(microphoneErrorMessage(new DOMException("x", "NotAllowedError"))).toBe(
      "Mikrofonberechtigung verweigert – bitte in den App-Einstellungen erlauben",
    );
    expect(microphoneErrorMessage(new DOMException("x", "NotFoundError"))).toBe(
      "Kein Mikrofon gefunden",
    );
    expect(microphoneErrorMessage(new DOMException("x", "NotReadableError"))).toBe(
      "Mikrofon wird von einer anderen App verwendet",
    );
    expect(microphoneErrorMessage(new DOMException("x", "AbortError"))).toBe(
      "Mikrofonfehler: AbortError",
    );
    expect(microphoneErrorMessage(new Error("kaputt"))).toBe("Mikrofonfehler: Error: kaputt");
  });
});
