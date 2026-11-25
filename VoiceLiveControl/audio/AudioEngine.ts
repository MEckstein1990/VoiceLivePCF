/**
 * Audio-Pipeline: AudioContext, Mikrofon-Graph und Wiedergabe-Zeitleiste.
 *
 * Audio-Eingang: Mikrofon → AudioWorklet (2 Eingänge: Mic + Echo-Referenz)
 *   → Resampling auf 24 kHz → PCM16 → Base64 → host.sendAudio()
 * Audio-Ausgang: play(base64) → PCM16 dekodieren → auf einer Zeitleiste
 *   (`nextPlayTime`) über `playbackBus` einplanen. Der Bus speist sowohl die
 *   Lautsprecher als auch Eingang 1 des Worklets (Echo-Referenz).
 *
 * Lebensdauer: Der AudioContext und der Wiedergabe-Bus überleben einzelne
 * Verbindungen (siehe ensureAudioContext). teardownSession() baut nur den
 * Sitzungs-Graph ab, erst dispose() schließt den Context.
 */

import { USE_LIVE_REFERENCE_AEC } from "../config";
import {
  VOICE_LIVE_SAMPLE_RATE,
  base64Pcm16ToFloat32,
  bufferToBase64,
  float32ToPcm16,
  interleave,
  resample,
} from "./pcm";
import { WORKLET_CODE } from "./workletCode";

/** Was die Audio-Pipeline vom Control braucht. */
export interface AudioEngineHost {
  log(msg: string): void;
  /** Darf ein Mikrofon-Block gesendet werden? (WebSocket offen, nicht stumm, keine geschützte Ansage) */
  canSend(): boolean;
  /** Sendet einen fertig kodierten Mikrofon-Block (Base64/PCM16, 24 kHz). */
  sendAudio(base64: string): void;
  /** Der letzte eingeplante Antwort-Chunk ist verklungen. */
  onPlaybackDrained(): void;
}

function defaultCreateContext(): AudioContext {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;

  return new Ctx();
}

/** Text für den Fall, dass getUserMedia im Browser fehlt. */
export const MIC_UNAVAILABLE_MESSAGE =
  "getUserMedia nicht verfügbar – HTTPS oder Browser-Support prüfen";

/** Übersetzt einen Fehler beim Mikrofonstart in eine verständliche Meldung. */
export function microphoneErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";

  const messages: Record<string, string> = {
    NotAllowedError:
      "Mikrofonberechtigung verweigert – bitte in den App-Einstellungen erlauben",

    PermissionDeniedError:
      "Mikrofonberechtigung verweigert – bitte in den App-Einstellungen erlauben",

    NotFoundError: "Kein Mikrofon gefunden",

    NotReadableError: "Mikrofon wird von einer anderen App verwendet",

    NotSupportedError:
      "Mikrofon-API nicht unterstützt (HTTPS erforderlich)",

    SecurityError:
      "Sicherheitseinschränkung – Seite muss über HTTPS geladen sein",
  };

  return messages[name] ?? `Mikrofonfehler: ${name || String(err)}`;
}

export class AudioEngine {
  private audioContext: AudioContext | null = null;
  /**
   * Sammelpunkt der Wiedergabe. Alle Antwort-Chunks laufen hierüber, weil der
   * Bus zwei Abnehmer hat: die Lautsprecher und – als Echo-Referenz für die
   * serverseitige Entzerrung – Eingang 1 des Mikrofon-Worklets.
   */
  private playbackBus: GainNode | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  /**
   * Quellknoten des Mikrofons. Muss als Feld geführt werden, weil nur er selbst
   * seine ausgehenden Kanten lösen kann – der AudioContext überlebt einzelne
   * Verbindungen und würde die Knoten sonst über die Sitzung hinaus behalten.
   */
  private micSource: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  /**
   * @param host          Callbacks ins Control
   * @param createContext Erzeugt den AudioContext (in Tests austauschbar)
   */
  constructor(
    private readonly host: AudioEngineHost,
    private readonly createContext: () => AudioContext = defaultCreateContext,
  ) {}

  /** Analyser am Mikrofon für die Visualisierung; null, solange keine Sitzung läuft. */
  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  /** Anzahl eingeplanter bzw. laufender Antwort-Chunks. */
  get activeCount(): number {
    return this.activeSources.length;
  }

  /** Wie lange die eingeplante Wiedergabe noch läuft, in Millisekunden. */
  get remainingPlaybackMs(): number {
    return this.audioContext
      ? Math.max(0, this.nextPlayTime - this.audioContext.currentTime) * 1000
      : 0;
  }

  /**
   * Liefert den AudioContext und legt ihn beim ersten Aufruf an.
   *
   * Der Context überlebt bewusst einzelne Verbindungen: Android entscheidet beim
   * Öffnen des Ausgabepfads einmalig, ob die Wiedergabe auf dem Musik- oder dem
   * Anruf-Stream landet. Würde er pro Sitzung neu erzeugt, fiele diese
   * Entscheidung jedes Mal neu – mit wechselnder Lautstärke als Folge.
   *
   * Die Worklet-Registrierung liegt im Erstell-Zweig, weil registerProcessor
   * beim zweiten Aufruf wirft. So kann das strukturell nicht passieren.
   */
  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = this.createContext();

      const blob = new Blob([WORKLET_CODE], {
        type: "application/javascript",
      });
      const workletUrl = URL.createObjectURL(blob);

      try {
        await this.audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      // Sammelpunkt der Wiedergabe. Er hängt an den Lautsprechern und wird
      // zusätzlich als Echo-Referenz in das Mikrofon-Worklet geführt
      // (siehe startMicrophone) – daher ein eigener Knoten statt destination.
      this.playbackBus = this.audioContext.createGain();
      this.playbackBus.connect(this.audioContext.destination);

      this.host.log("AudioContext angelegt, Worklet registriert, Wiedergabe-Bus verbunden");
    }

    // Bewusst ohne Zustandsprüfung: Verbindet man schnell wieder, könnte der
    // Context gerade noch suspendiert werden – eine Prüfung würde das resume
    // überspringen und der Context bliebe stumm zurück. Auf einem laufenden
    // Context ist resume() ein No-op.
    await this.audioContext.resume();

    return this.audioContext;
  }

  // #region Mikrofon

  /**
   * Mikrofon-Aufnahme starten und Audio-Pipeline aufbauen.
   *
   * Pipeline:
   *   Mikrofon → MediaStreamSource → AudioWorklet → Resample → PCM16 → Base64 → host.sendAudio
   *                                 ↘ Analyser → Visualisierung (Orb + VU-Meter)
   *
   * Kein manueller Noise Gate – Voice Live macht serverseitige Noise Suppression.
   *
   * @returns null bei Erfolg, sonst eine Fehlermeldung für die Statusanzeige.
   */
  async startMicrophone(): Promise<string | null> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        return MIC_UNAVAILABLE_MESSAGE;
      }

      // Genau eine Instanz unterdrückt das Echo: entweder der Server über
      // Live-Reference AEC oder das Gerät. Beides zusammen wäre doppelt,
      // keines von beiden ließe KoRa sich selbst ins Wort fallen.
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !USE_LIVE_REFERENCE_AEC,
        },
        video: false,
      });

      const ctx = await this.ensureAudioContext();
      const nativeRate = ctx.sampleRate;

      // Die Uhr des Contexts läuft über Verbindungspausen weiter – Zeitlinie zurücksetzen.
      this.nextPlayTime = ctx.currentTime;

      this.micSource = ctx.createMediaStreamSource(this.mediaStream);

      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.micSource.connect(this.analyserNode);

      // Zwei Eingänge: Mikrofon und Echo-Referenz. Der Wiedergabe-Bus liegt
      // parallel auf den Lautsprechern und auf Eingang 1 – so bekommt der
      // Server genau das Signal als Referenz, das der Benutzer wirklich hört.
      this.audioWorklet = new AudioWorkletNode(ctx, "processor", {
        numberOfInputs: 2,
      });
      this.micSource.connect(this.audioWorklet, 0, 0);
      this.playbackBus?.connect(this.audioWorklet, 0, 1);

      // Daten vom Worklet empfangen und an den WebSocket senden
      this.audioWorklet.port.onmessage = (e: MessageEvent) => {
        // canSend() hält u. a. die Ruhemodus-Ansage unterbrechungsfest:
        // Ohne Upstream-Audio erkennt das server-seitige VAD keine Sprache,
        // also kann weder der Server noch der Client die Ansage abbrechen.
        if (!this.host.canSend()) return;

        const { mic, reference } = e.data as {
          mic: Float32Array;
          reference: Float32Array;
        };

        // Beide Kanäle einzeln resampeln – der Context läuft auf Geräterate,
        // gesendet wird mit 24 kHz. Erst danach verschränken, sonst würde das
        // Resampling die Sample-Paare auseinanderreißen.
        //
        // Ohne Live-Reference AEC erwartet der Server Mono. Stereo zu senden
        // läse er als Mono und verstünde nichts mehr – der Referenzkanal
        // bleibt dann also weg.
        const micResampled = resample(mic, nativeRate);
        const payload = USE_LIVE_REFERENCE_AEC
          ? interleave(micResampled, resample(reference, nativeRate))
          : micResampled;

        const pcm16 = float32ToPcm16(payload);

        this.host.sendAudio(bufferToBase64(pcm16.buffer as ArrayBuffer));
      };

      this.host.log("AudioWorklet gestartet, Mikrofonaufnahme läuft");

      return null;
    } catch (err: unknown) {
      return microphoneErrorMessage(err);
    }
  }

  // #endregion

  // #region Wiedergabe

  /** Dekodiert einen Base64/PCM16-Audio-Chunk und plant ihn lückenlos auf der Wiedergabe-Zeitleiste ein. */
  play(base64: string): void {
    if (!this.audioContext) return;

    const float32 = base64Pcm16ToFloat32(base64);

    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32.length,
      VOICE_LIVE_SAMPLE_RATE,
    );

    audioBuffer.getChannelData(0).set(float32);
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    // Über den Bus statt direkt auf destination: Er speist zusätzlich den
    // Referenzkanal des Worklets für die serverseitige Echounterdrückung.
    source.connect(this.playbackBus ?? this.audioContext.destination);
    const now = this.audioContext.currentTime;
    const startAt = Math.max(now, this.nextPlayTime);
    source.start(startAt);

    source.onended = () => {
      const idx = this.activeSources.indexOf(source);

      if (idx >= 0) this.activeSources.splice(idx, 1);

      // Letzter Chunk fertig abgespielt – das Control entscheidet, was folgt
      // (Wechsel auf "listening" oder Nachlaufzeit des Ruhemodus).
      if (this.activeSources.length === 0) {
        this.host.onPlaybackDrained();
      }
    };

    this.activeSources.push(source);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

  /**
   * Stoppt alle eingeplanten Chunks sofort.
   *
   * onended wird vorher gelöst: stop() feuert es asynchron, das Array ist dann
   * längst leer – der Handler würde eine Transition scharfschalten, obwohl die
   * Wiedergabe gerade abgebrochen wird.
   */
  stopPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* ignore */
      }
    }

    this.activeSources = [];
  }

  /** Setzt die Zeitleiste auf jetzt – die nächste Antwort startet sofort. */
  resetTimeline(): void {
    if (this.audioContext) {
      this.nextPlayTime = this.audioContext.currentTime;
    }
  }

  // #endregion

  // #region Abbau

  /**
   * Baut den Sitzungs-Graph ab (Worklet, Mikrofonquelle, Analyser, Tracks).
   * Eingeplante Wiedergabe stoppt stopPlayback().
   *
   * Der AudioContext überlebt einzelne Verbindungen (siehe
   * ensureAudioContext), also muss der Sitzungs-Graph hier von Hand abgebaut
   * werden. Bleiben die Knoten stehen, sammeln sich Quellknoten auf beendeten
   * MediaStreams an und der neue Mikrofonpfad liefert keine Daten mehr.
   *
   * Reihenfolge ist wichtig: erst die Knoten trennen, dann die Tracks
   * stoppen. Andersherum steht kurzzeitig ein Quellknoten auf einem
   * beendeten Stream im Graph – genau der Zustand, der das Problem auslöst.
   *
   * Bewusst kein suspend(): Das schließt den Ausgabepfad, und beim Öffnen
   * entscheidet Android neu, ob die Wiedergabe auf dem Musik- oder dem
   * Anruf-Stream landet. Der Context läuft durch, sein Graph ist danach leer
   * und rendert Stille.
   */
  teardownSession(): void {
    if (this.audioWorklet) {
      // Handler lösen, bevor der Knoten geht: Ein noch lebendes Worklet würde
      // sonst Audio in die nächste Sitzung schieben.
      this.audioWorklet.port.onmessage = null;
      this.audioWorklet.port.close();

      // Die Referenz-Kante gehört dem Bus, nicht dem Worklet – sie muss dort
      // gelöst werden. Gezielt nur diese eine Verbindung, sonst verliert der
      // Bus auch die Lautsprecher. Der Bus selbst überlebt die Sitzung.
      try {
        this.playbackBus?.disconnect(this.audioWorklet, 0, 1);
      } catch {
        /* war nicht verbunden */
      }

      this.audioWorklet.disconnect();
      this.audioWorklet = null;
    }

    if (this.micSource) {
      // disconnect() muss auf der Quelle passieren – die Kante zum Worklet
      // hängt an ihr, nicht am Zielknoten.
      this.micSource.disconnect();
      this.micSource = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }

  /**
   * Schließt den AudioContext endgültig (beim Zerstören des Controls).
   *
   * Sonst stapeln sich in einer Canvas App bei jedem Screen-Wechsel neue
   * Contexts, bis der Browser keinen weiteren zulässt. Bewusst nicht in
   * teardownSession(): Dort würde ein close() die Wiederverwendung zunichtemachen.
   */
  dispose(): void {
    if (this.playbackBus) {
      this.playbackBus.disconnect();
      this.playbackBus = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  // #endregion
}
