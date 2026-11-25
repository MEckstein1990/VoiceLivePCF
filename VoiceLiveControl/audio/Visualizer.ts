/**
 * Treibt Orb-Skalierung und VU-Meter aus der Lautstärke (RMS) des
 * Mikrofonsignals.
 */
export class Visualizer {
  private animationFrameId: number | null = null;

  /**
   * @param orb            Orb, der beim Sprechen des Nutzers pulsiert
   * @param bars           Balken des VU-Meters
   * @param getAnalyser    Analyser der laufenden Sitzung (null nach dem Trennen)
   * @param isMuted        Mikrofon stummgeschaltet?
   * @param isUserSpeaking Spricht der Nutzer gerade (State "user-speaking")?
   */
  constructor(
    private readonly orb: HTMLDivElement,
    private readonly bars: HTMLDivElement[],
    private readonly getAnalyser: () => AnalyserNode | null,
    private readonly isMuted: () => boolean,
    private readonly isUserSpeaking: () => boolean,
  ) {}

  start(): void {
    const initial = this.getAnalyser();
    if (!initial) return;
    const dataArray = new Uint8Array(initial.frequencyBinCount);
    const barCount = this.bars.length;

    const tick = () => {
      // Der Analyser wird beim Trennen genullt – ohne Prüfung würde eine bereits
      // eingeplante Frame-Ausführung hier krachen.
      const analyser = this.getAnalyser();
      if (!analyser) {
        this.animationFrameId = null;
        return;
      }

      this.animationFrameId = requestAnimationFrame(tick);
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;

      // Nur tatsächliche Lautstärke berechnen, wenn nicht gemuted
      if (!this.isMuted()) {
        for (const v of dataArray) sum += v ** 2;
      }

      const rms = Math.sqrt(sum / dataArray.length) / 255;
      const level = Math.min(rms * 3.5, 1);

      if (this.isUserSpeaking() && this.orb) {
        this.orb.style.transform = `scale(${(1 + level * 0.35).toFixed(3)})`;
      }

      for (let i = 0; i < barCount; i++) {
        const idx = Math.floor((i / barCount) * dataArray.length * 0.45);

        // VU-Bars bei Mute fest auf 3px (Minimalhöhe) zwingen
        const h = Math.max(3, this.isMuted() ? 3 : (dataArray[idx] / 255) * 26);
        this.bars[i].style.height = `${h}px`;
      }
    };

    tick();
  }

  /** Hält die Animationsschleife an. */
  stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);

      this.animationFrameId = null;
    }
  }

  /** Orb und Balken in die Ruhestellung. */
  reset(): void {
    if (this.orb) this.orb.style.transform = "";

    this.bars.forEach((b) => {
      b.style.height = "3px";
    });
  }
}
