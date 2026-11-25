/**
 * Ruhemodus (Inaktivität → Dormant).
 *
 * Ohne MCP-Tool-Aufrufe wird die Anwendung nicht produktiv genutzt. Reines
 * Sprechen taugt bewusst NICHT als Aktivitätssignal – sonst würden fremde
 * Gespräche im Raum die Session offen halten, genau das soll verhindert
 * werden. Nach Ablauf der Frist kündigt die KI den Ruhemodus unterbrechungs-
 * fest an; kurz nach dem Ende der Ansage wird die Verbindung getrennt.
 *
 * Ablauf der Phasen: siehe DormancyPhase in types.ts. Das eigentliche Trennen
 * (enterDormant) und das Aufwecken übernimmt das Control, weil sie die Session
 * ab- bzw. aufbauen.
 */

import { DORMANT_CANCEL_PROMPT, DORMANT_WARNING_PROMPT } from "../agent/prompts";
import { userText } from "../agent/messages";
import {
  ControlConfig,
  IDLE_CHECK_INTERVAL_MS,
  MAX_DEFER_MS,
  QUIET_GATE_MS,
  WARNING_WATCHDOG_MS,
} from "../config";
import { DormancyPhase } from "../types";

/** Was der Ruhemodus vom Control braucht. */
export interface DormancyHost {
  log(msg: string): void;
  /** Aktuelle Konfiguration (wird in updateView ersetzt, daher als Funktion). */
  config(): Pick<ControlConfig, "dormantEnabled" | "idleTimeoutMs" | "dormantDelayMs">;
  /** Darf jetzt eine Ansage starten? (Zustand "listening", WebSocket offen, kein laufender Abbruch) */
  canAnnounce(): boolean;
  /** Anzahl der Nachrichten im Gesprächsverlauf. */
  conversationLength(): number;
  /** Restlaufzeit der eingeplanten Wiedergabe in Millisekunden. */
  remainingPlaybackMs(): number;
  sendJson(obj: unknown): void;
  /** Zustand "listening" setzen (überschreibt den Countdown-Text). */
  setListening(): void;
  /** Text direkt in die Statuszeile schreiben, ohne Zustandswechsel. */
  showStatusText(text: string): void;
  /** CSS-Klasse "dormant-pending" am Container setzen bzw. entfernen. */
  setPendingClass(on: boolean): void;
  /** Verbindung trennen und in den Ruhemodus wechseln. */
  enterDormant(): void;
}

/** Countdown-Text vor dem Trennen. */
export function countdownText(seconds: number): string {
  const unit = seconds === 1 ? "Sekunde" : "Sekunden";
  return `Ruhemodus in ${seconds} ${unit}…`;
}

export class DormancyController {
  private phaseValue: DormancyPhase = "none";
  /** Zeitstempel des letzten MCP-Tool-Aufrufs – Basis der Inaktivitätsmessung. */
  private lastToolCallAt = 0;
  /** Zeitstempel der letzten Gesprächsaktivität – speist das Quiet-Gate. */
  private lastConversationAt = 0;
  /** Seit wann die Warnung wegen laufendem Gespräch aufgeschoben wird. */
  private deferredSince: number | null = null;
  /** Die Ansage ist formuliert, ihr Audio läuft noch – beim letzten onended geht es weiter. */
  private pendingTransition = false;
  /** Tippen während der Ansage – wird ausgewertet, sobald sie durch ist. */
  private cancelRequestedDuringWarning = false;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private warningWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sekundentakt des sichtbaren Countdowns vor dem Trennen. */
  private dormantCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Länge des Gesprächsverlaufs vor der Ruhemodus-Ansage – kürzt sie beim Wecken weg. */
  private chatLengthBeforeWarning: number | null = null;

  constructor(private readonly host: DormancyHost) {}

  get phase(): DormancyPhase {
    return this.phaseValue;
  }

  /** Während der Ruhemodus-Ansage darf der User die KI nicht unterbrechen. */
  get isProtectedResponse(): boolean {
    return this.phaseValue !== "none" && this.phaseValue !== "dormant";
  }

  /**
   * Länge des Verlaufs vor der Ansage. enterDormant liest sie, bevor der
   * Abbau der Verbindung (abort) den Merker verwirft.
   */
  get lengthBeforeWarning(): number | null {
    return this.chatLengthBeforeWarning;
  }

  // #region Aktivität

  /** Setzt die Inaktivitätsmessung zurück (echte Nutzung erkannt). */
  resetIdleTimer(): void {
    this.lastToolCallAt = Date.now();
    this.deferredSince = null;
  }

  /** Merkt Gesprächsaktivität für das Quiet-Gate – KEIN Reset der Frist. */
  markConversationActivity(): void {
    this.lastConversationAt = Date.now();
  }

  /**
   * Ein MCP-Tool-Aufruf ist echte Nutzung und verlängert die Frist.
   *
   * Während der Ansage bewusst wirkungslos: Reagiert die KI auf den
   * SYSTEM-HINWEIS trotz Anweisung mit einem Tool-Aufruf, würde der Reset den
   * Ablauf abbrechen, während die Phase auf "warning" stehen bleibt – das
   * Mikrofon bliebe dauerhaft stumm.
   */
  noteToolActivity(): void {
    this.markConversationActivity();

    if (this.phaseValue !== "none") return;

    this.resetIdleTimer();
  }

  // #endregion

  // #region Inaktivitätsprüfung

  /** Startet die periodische Inaktivitätsprüfung (idempotent). */
  startIdleWatch(): void {
    if (this.idleCheckTimer !== null) return;

    this.idleCheckTimer = setInterval(
      () => this.onIdleTick(),
      IDLE_CHECK_INTERVAL_MS,
    );
  }

  /** Beendet die periodische Prüfung (beim Abbau der Verbindung). */
  stopIdleWatch(): void {
    if (this.idleCheckTimer !== null) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  /**
   * Prüft, ob die Inaktivitätsfrist abgelaufen ist.
   *
   * Zeitstempel plus periodischer Tick statt eines einmaligen setTimeout:
   * Läuft beim Ablauf der Frist gerade eine Antwort, muss die Ansage
   * aufgeschoben werden (siehe Quiet-Gate unten). Ein einmaliger Timer müsste
   * sich dafür selbst neu stellen – der Tick prüft ohnehin wieder nach.
   * Nebeneffekt: Der Zeitstempel übersteht auch einen Verbindungsabbruch.
   */
  private onIdleTick(): void {
    const config = this.host.config();

    if (!config.dormantEnabled) return;
    if (this.phaseValue !== "none") return;
    if (!this.host.canAnnounce()) return;

    if (Date.now() - this.lastToolCallAt < config.idleTimeoutMs) return;

    // Quiet-Gate: speech_stopped setzt sofort "listening", response.created
    // folgt erst einige hundert ms später. Eine Ansage in dieses Fenster
    // würde als zweite Response kollidieren (conversation_already_has_active_response).
    const quietFor = Date.now() - this.lastConversationAt;
    if (quietFor < QUIET_GATE_MS) {
      if (this.deferredSince === null) {
        this.deferredSince = Date.now();
        this.host.log("Ruhemodus-Ansage aufgeschoben – Gespräch noch aktiv");
      } else if (
        Date.now() - this.deferredSince >= MAX_DEFER_MS
      ) {
        this.host.log("Ruhemodus-Ansage wird trotz Aktivität erzwungen");
        this.triggerWarning();
      }
      return;
    }

    this.triggerWarning();
  }

  // #endregion

  // #region Ansage und Countdown

  /** Lässt die KI den Ruhemodus ankündigen – unterbrechungsfest. */
  private triggerWarning(): void {
    this.host.log("Inaktivität erkannt – kündige Ruhemodus an");

    // Ab hier sendet das Mikrofon nichts mehr (canSend prüft isProtectedResponse).
    // Ohne Upstream-Audio feuert das server-seitige VAD nicht, die Ansage
    // kann also weder client- noch serverseitig unterbrochen werden.
    this.phaseValue = "warning";
    this.deferredSince = null;

    // Merkt sich, wo der Verlauf endet – die Ansage selbst soll beim Aufwecken
    // nicht als Gesprächskontext zurückgespielt werden.
    this.chatLengthBeforeWarning = this.host.conversationLength();

    this.host.sendJson(userText(DORMANT_WARNING_PROMPT));
    this.host.sendJson({ type: "response.create" });

    // Not-Aus, falls die Ansage nie beantwortet wird oder kein Audio kommt.
    this.warningWatchdogTimer = setTimeout(() => {
      this.warningWatchdogTimer = null;
      this.host.log("Watchdog: Ansage blieb aus – gehe trotzdem in den Ruhemodus");
      this.host.enterDormant();
    }, WARNING_WATCHDOG_MS);
  }

  /**
   * response.done: Ist das die Ruhemodus-Ansage, übernimmt der Ruhemodus.
   *
   * Bewusst KEIN pendingListeningTransition im Control – sonst würde das
   * letzte onended erst auf "listening" schalten (grüner Verbunden-Punkt) und
   * dann trennen.
   *
   * @param activeAudioCount Anzahl der noch laufenden Audio-Chunks
   * @returns true, wenn der Ruhemodus das Ende der Antwort übernommen hat.
   */
  onResponseDone(activeAudioCount: number): boolean {
    if (this.phaseValue !== "warning") return false;

    // Die Ruhemodus-Ansage ist fertig formuliert.
    if (activeAudioCount > 0) {
      this.pendingTransition = true;
      this.host.log(
        `Ruhemodus-Ansage: ${activeAudioCount} Audio-Chunks laufen noch`,
      );
      this.armBackupTimer();
    } else {
      // Ansage ohne Audio (Textantwort, leer beendete Response).
      this.armDelay();
    }

    return true;
  }

  /** Der letzte Audio-Chunk ist verklungen. */
  onPlaybackDrained(): void {
    // Ruhemodus-Ansage ist verklungen → Nachlaufzeit starten
    if (this.pendingTransition) {
      this.pendingTransition = false;
      if (this.phaseValue === "warning") {
        this.armDelay();
      }
    }
  }

  /**
   * Ersetzt den Watchdog durch eine berechnete Frist, sobald die Länge der
   * Ansage bekannt ist.
   *
   * Deckt den Fall ab, dass onended nie feuert – etwa wenn der AudioContext im
   * Hintergrund-Tab suspendiert wird. Der Ruhemodus greift dann trotzdem:
   * Ist die Ansage nicht hörbar, ist der Benutzer erst recht nicht da.
   */
  private armBackupTimer(): void {
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    const remainingPlaybackMs = this.host.remainingPlaybackMs();

    const deadline = remainingPlaybackMs + this.host.config().dormantDelayMs + 2000;

    this.warningWatchdogTimer = setTimeout(() => {
      this.warningWatchdogTimer = null;
      this.host.log("Playback-Ende blieb aus – gehe trotzdem in den Ruhemodus");
      this.host.enterDormant();
    }, deadline);
  }

  /** Ansage ist verklungen – kurze Nachlaufzeit, dann trennen. */
  private armDelay(): void {
    if (this.phaseValue !== "warning") return;

    // Wer schon während der Ansage getippt hat, bekommt gar keinen Countdown.
    if (this.cancelRequestedDuringWarning) {
      this.pendingTransition = false;
      this.cancel();

      return;
    }

    this.phaseValue = "pending-dormant";
    this.pendingTransition = false;
    this.host.setPendingClass(true);

    // Der Not-Aus hat seinen Zweck erfüllt – ab hier zählt nur noch die Nachlaufzeit.
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    if (this.dormantCountdownTimer !== null) {
      clearInterval(this.dormantCountdownTimer);
    }

    let remaining = Math.round(this.host.config().dormantDelayMs / 1000);
    this.host.log(`Ansage beendet – Ruhemodus in ${remaining}s`);

    // Erste Anzeige sofort, nicht erst nach der ersten Sekunde – sonst bliebe
    // eine Sekunde lang der alte Statustext stehen.
    //
    // Bewusst nicht über setState: Das würde den Text beim nächsten
    // Zustandswechsel überschreiben (gleiches Muster wie setToolStatus).
    this.host.showStatusText(countdownText(remaining));

    this.dormantCountdownTimer = setInterval(() => {
      remaining--;

      if (remaining <= 0) {
        if (this.dormantCountdownTimer !== null) {
          clearInterval(this.dormantCountdownTimer);
          this.dormantCountdownTimer = null;
        }
        this.host.enterDormant();
        return;
      }

      this.host.showStatusText(countdownText(remaining));
    }, 1000);
  }

  // #endregion

  // #region Abbruch durch den Benutzer

  /**
   * Tippen irgendwo auf das Control während des Ruhemodus-Ablaufs.
   *
   * Der Connect-Button ist ausgenommen – er behält seine Trennen-Funktion,
   * damit derselbe Knopf nicht je nach Zeitpunkt Gegenteiliges tut.
   */
  onPointerDown(target: Element | null): void {
    if (this.phaseValue !== "warning" && this.phaseValue !== "pending-dormant") {
      return;
    }

    if (target?.closest(".ai-voice-connect-btn")) return;

    if (this.phaseValue === "pending-dormant") {
      this.cancel();
      return;
    }

    // Während der Ansage läuft noch eine Response – ein sofortiger Abbruch
    // bräuchte ein zweites response.create und würde kollidieren. Also nur
    // vormerken; armDelay() wertet es aus, sobald die Ansage durch ist.
    if (!this.cancelRequestedDuringWarning) {
      this.cancelRequestedDuringWarning = true;
      this.host.log("Abbruch während der Ansage vorgemerkt");
    }
  }

  /**
   * Der Benutzer hat sich gemeldet – Ruhemodus abblasen, Verbindung behalten.
   *
   * Anders als abort() wird die Inaktivitätsfrist hier zurückgesetzt.
   * Das ist die bewusste Ausnahme von "nur MCP-Tool-Calls zählen": Ein Tippen
   * ist ein eindeutiger Anwesenheitsnachweis, Geräusch im Raum wäre es nicht.
   * Ohne den Reset würde der nächste Tick die Ansage sofort erneut auslösen.
   */
  private cancel(): void {
    this.host.log("Ruhemodus durch Benutzer abgebrochen");

    this.abort();
    this.resetIdleTimer();
    this.markConversationActivity();

    // Überschreibt den Countdown-Text mit dem normalen Status.
    this.host.setListening();

    this.host.sendJson(userText(DORMANT_CANCEL_PROMPT));
    this.host.sendJson({ type: "response.create" });
  }

  // #endregion

  // #region Abbruch, Ruhemodus, Aufwecken

  /**
   * Bricht einen laufenden Ruhemodus-Ablauf ab (Verbindungsabbruch, Fehler,
   * manuelles Trennen, Kill-Switch).
   *
   * lastToolCallAt bleibt bewusst unangetastet: Die Inaktivität endet nicht
   * dadurch, dass die Verbindung neu aufgebaut wurde. Kommt die Session zurück,
   * löst der nächste Tick die Ansage erneut aus.
   */
  abort(): void {
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    if (this.dormantCountdownTimer !== null) {
      clearInterval(this.dormantCountdownTimer);
      this.dormantCountdownTimer = null;
    }

    this.pendingTransition = false;
    this.chatLengthBeforeWarning = null;
    this.cancelRequestedDuringWarning = false;
    this.host.setPendingClass(false);

    // "dormant" ist ein Ruhezustand, kein laufender Ablauf – nicht zurücksetzen.
    if (this.phaseValue !== "dormant" && this.phaseValue !== "none") {
      this.host.log("Ruhemodus-Ablauf abgebrochen");
      this.phaseValue = "none";
    }
  }

  /** Verbindung ist getrennt – ab jetzt Ruhemodus (nach dem Abbau aufrufen). */
  markDormant(): void {
    this.phaseValue = "dormant";
  }

  /** Vor dem Aufwecken: Phase verlassen und die Frist neu starten. */
  prepareWake(): void {
    this.phaseValue = "none";

    // Ohne Reset läge der Zeitstempel weiterhin jenseits der Frist und der
    // erste Tick würde die frisch geweckte Session sofort wieder schlafen legen.
    this.resetIdleTimer();
    this.markConversationActivity();
  }

  /**
   * Vollständiger Ausstieg – auch aus dem Ruhemodus heraus. abort() lässt
   * "dormant" bewusst stehen, hier muss die Phase aber weg, sonst blockiert
   * sie die Inaktivitätsprüfung der nächsten Session.
   */
  reset(): void {
    this.phaseValue = "none";
    this.chatLengthBeforeWarning = null;
  }

  // #endregion
}
