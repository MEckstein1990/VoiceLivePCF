/**
 * Reine Audio-Umrechnungen zwischen Web Audio (Float32) und dem Format der
 * Voice Live API (PCM16, 24 kHz, Base64).
 */

/** Abtastrate, mit der Voice Live sendet und empfängt. */
export const VOICE_LIVE_SAMPLE_RATE = 24000;

/** Nearest-Neighbor-Resampling auf 24 kHz – kein Anti-Aliasing-Filter. */
export function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === VOICE_LIVE_SAMPLE_RATE) return input;
  const ratio = fromRate / VOICE_LIVE_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

/**
 * Verschränkt Mikrofon und Echo-Referenz zu Stereo für die serverseitige
 * Echounterdrückung: [mic0, ref0, mic1, ref1, …].
 *
 * Die Reihenfolge ist von der Voice Live API vorgegeben – pro Sample-Paar
 * zuerst das Mikrofon, dann die Referenz. Kanal 1 wird auf die Länge von
 * Kanal 0 gezwungen, damit die Paare auch dann stimmen, wenn beide Puffer
 * durch das Resampling um ein Sample auseinanderlaufen.
 */
export function interleave(mic: Float32Array, reference: Float32Array): Float32Array {
  const out = new Float32Array(mic.length * 2);

  for (let i = 0; i < mic.length; i++) {
    out[i * 2] = mic[i];
    out[i * 2 + 1] = i < reference.length ? reference[i] : 0;
  }

  return out;
}

/** Float32 (-1…1) → PCM16, Werte außerhalb werden begrenzt. */
export function float32ToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));

    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return output;
}

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

/** Dekodiert einen Base64/PCM16-Audio-Chunk der Voice Live API zu Float32. */
export function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);

  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

  return float32;
}
