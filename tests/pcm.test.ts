import { describe, expect, it } from "vitest";
import {
  base64Pcm16ToFloat32,
  bufferToBase64,
  float32ToPcm16,
  interleave,
  resample,
} from "../VoiceLiveControl/audio/pcm";

describe("resample", () => {
  it("gibt bei 24 kHz denselben Puffer zurück", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(input, 24000)).toBe(input);
  });

  it("halbiert die Länge von 48 kHz und nimmt jedes zweite Sample", () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(resample(input, 48000))).toEqual([0, 2, 4, 6]);
  });

  it("rundet die Länge bei 44,1 kHz ab", () => {
    // 128 Samples (ein Render-Quantum) bei 44,1 kHz → floor(128 / 1,8375) = 69
    expect(resample(new Float32Array(128), 44100).length).toBe(69);
  });
});

describe("interleave", () => {
  it("verschränkt Mikrofon und Referenz paarweise", () => {
    const out = interleave(new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3]));
    expect(Array.from(out)).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("füllt eine zu kurze Referenz mit Stille auf", () => {
    const out = interleave(new Float32Array([1, 2, 3]), new Float32Array([-1, -2]));
    expect(Array.from(out)).toEqual([1, -1, 2, -2, 3, 0]);
  });

  it("schneidet eine zu lange Referenz auf die Mikrofonlänge", () => {
    const out = interleave(new Float32Array([1]), new Float32Array([-1, -2]));
    expect(Array.from(out)).toEqual([1, -1]);
  });
});

describe("float32ToPcm16", () => {
  it("bildet die Grenzwerte auf den Int16-Bereich ab", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-1, 0, 1])))).toEqual([-32768, 0, 32767]);
  });

  it("begrenzt Werte außerhalb von -1…1", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-2, 2])))).toEqual([-32768, 32767]);
  });
});

describe("Base64-Rundweg", () => {
  it("kodiert PCM16 und dekodiert es wieder zu Float32", () => {
    const pcm = new Int16Array([0, 16384, -16384, -32768]);
    const base64 = bufferToBase64(pcm.buffer);
    expect(Array.from(base64Pcm16ToFloat32(base64))).toEqual([0, 0.5, -0.5, -1]);
  });

  it("kodiert Bytes als Standard-Base64", () => {
    expect(bufferToBase64(new Uint8Array([72, 105]).buffer)).toBe("SGk=");
  });
});
