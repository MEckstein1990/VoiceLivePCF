/**
 * Voice Live API – Real-time Voice Chat – PCF Control
 *
 * Dieses Power Apps Component Framework (PCF) Control implementiert einen
 * bidirektionalen Echtzeit-Sprachdialog mit einem KI-Assistenten. Es nutzt
 * die Azure KI Foundry (Project AI) für das Agenten-Backend und die
 * Azure Voice Live API für die Sprachverarbeitung.
 *
 * Hauptmerkmale:
 * - **Echtzeit-Kommunikation:** Streaming von Audio zum Server und Empfang von
 *   Audio-Antworten in Echtzeit über WebSockets.
 * - **Foundry Agent Integration:** Verbindet sich mit einem vordefinierten
 *   Foundry-Agenten, der die Dialoglogik und Tool-Nutzung steuert.
 * - **WebSocket-Proxy:** Nutzt eine Azure Function als sicheren Proxy, um
 *   API-Keys und Endpunkte zu verwalten, anstatt sie im Client preiszugeben.
 * - **Dynamische UI:** Eine animierte Orb-Visualisierung zeigt den aktuellen
 *   Status (zuhören, sprechen, KI-Antwort) an.
 * - **Barge-In:** Benutzer können die KI-Antwort jederzeit unterbrechen, indem
 *   sie einfach zu sprechen beginnen.
 * - **Konfigurierbarkeit:** Wichtige Parameter wie KI-Stimme, Sprache,
 *   Sprechpausen (VAD) und mehr können direkt in Power Apps konfiguriert werden.
 * - **Transkript-Anzeige:** Ein optionales Chat-Panel zeigt das Gesprächs-
 *   transkript im WhatsApp-Stil an.
 *
 * Architektur (Kurzüberblick für den Einstieg):
 * - **Audio-Eingang:** Mikrofon → AudioWorklet (2 Eingänge: Mic + Echo-Referenz)
 *   → Resampling auf 24 kHz → PCM16 → Base64 → `input_audio_buffer.append`.
 * - **Audio-Ausgang:** `response.audio.delta` → PCM16 dekodieren → auf einer
 *   Zeitleiste (`nextPlayTime`) über `playbackBus` einplanen. Der Bus speist
 *   sowohl die Lautsprecher als auch Eingang 1 des Worklets (Echo-Referenz).
 *   Beides steckt in `audio/AudioEngine.ts`.
 * - **Session-Start-Modi:** `new` (frischer Start), `reconnect` (nach
 *   Verbindungsabbruch) und `wake` (nach Ruhemodus) behalten oder verwerfen
 *   den Gesprächsverlauf – siehe `SessionStartMode` und `startSession()`.
 * - **Vierstufiger Abbau:** `cleanupConnection()` (WS + Audio-Graph, Chat
 *   bleibt) → `cleanup()` (+ Reconnect-Timer) → `stopSession()` (+ Ruhemodus-
 *   Reset, State → idle) → `destroy()` (+ AudioContext endgültig schließen).
 * - **Bekanntes Problem (Android):** Lautstärketasten wirken nach der ersten
 *   Verbindung nicht mehr zuverlässig – Ursache, Lösungswege und Status stehen
 *   in `../docs/lautstaerke-routing-android.md`. Siehe auch das Flag
 *   `USE_LIVE_REFERENCE_AEC` in `config.ts`.
 */

import { IInputs, IOutputs } from "./generated/ManifestTypes";

import {
  ControlState,
  DormancyPhase,
  ServerEvent,
  SessionStartMode,
} from "./types";
import {
  ControlConfig,
  IDLE_CHECK_INTERVAL_MS,
  INITIAL_CONFIG,
  MAX_DEFER_MS,
  MAX_RECONNECT_ATTEMPTS,
  QUIET_GATE_MS,
  USE_LIVE_REFERENCE_AEC,
  WARNING_WATCHDOG_MS,
  readConfig,
} from "./config";
import {
  DORMANT_CANCEL_PROMPT,
  DORMANT_RESUME_PROMPT,
  DORMANT_WARNING_PROMPT,
  RECONNECT_RESUME_PROMPT,
  greetingPrompt,
} from "./agent/prompts";
import { buildSessionPayload, historyItems, userText } from "./agent/messages";
import { getToolDisplayText } from "./agent/toolStatus";
import { AudioEngine } from "./audio/AudioEngine";
import { Visualizer } from "./audio/Visualizer";
import {
  backoffDelay,
  closeCodeToMessage,
  isRecoverableClose,
} from "./session/reconnect";
import { SessionTokenRequester } from "./session/sessionToken";
import { Conversation } from "./conversation/Conversation";
import { ChatView } from "./ui/ChatView";
import { EventLog } from "./ui/EventLog";
import { describeState } from "./ui/statusView";
import { renderTemplate } from "./ui/template";

export class VoiceLiveControl implements ComponentFramework.StandardControl<
  IInputs,
  IOutputs
> {
  // #region Felder

  // #region Infrastruktur
  private container!: HTMLDivElement;
  private notifyOutputChanged!: () => void;
  private ws: WebSocket | null = null;
  /** Audio-Pipeline: Mikrofon, Wiedergabe, AudioContext (siehe audio/AudioEngine.ts). */
  private audio = new AudioEngine({
    log: (msg) => this.log(msg),
    // Ruhemodus-Ansage: siehe isProtectedResponse
    canSend: () =>
      this.ws?.readyState === WebSocket.OPEN &&
      !this.isMuted &&
      !this.isProtectedResponse,
    sendAudio: (audio) =>
      this.sendJson({ type: "input_audio_buffer.append", audio }),
    onPlaybackDrained: () => this.onPlaybackDrained(),
  });
  /** Orb und VU-Meter – wird in renderUI() angelegt. */
  private visualizer!: Visualizer;
  private controlState: ControlState = "idle";
  private previousIsActive: boolean | null = null;
  private isCancelling = false;
  private isMuted = false;
  private greetingSent = false;
  private pendingListeningTransition = false;
  private currentToolName: string | null = null;
  /** Ein MCP-Aufruf der laufenden Antwort ist fertig; die Antwort darauf muss noch angefordert werden. */
  private mcpFollowUpPending = false;

  // #endregion

  // #region Ruhemodus (Zustand & Konstanten)
  private dormancyPhase: DormancyPhase = "none";
  /** Zeitstempel des letzten MCP-Tool-Aufrufs – Basis der Inaktivitätsmessung. */
  private lastToolCallAt = 0;
  /** Zeitstempel der letzten Gesprächsaktivität – speist das Quiet-Gate. */
  private lastConversationAt = 0;
  /** Seit wann die Warnung wegen laufendem Gespräch aufgeschoben wird. */
  private deferredSince: number | null = null;
  private pendingDormantTransition = false;
  /** Tippen während der Ansage – wird ausgewertet, sobald sie durch ist. */
  private cancelRequestedDuringWarning = false;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private warningWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sekundentakt des sichtbaren Countdowns vor dem Trennen. */
  private dormantCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Löst nach dem Wiederverbinden eine kurze Rückmeldung der KI aus. */
  private pendingResumeResponse = false;
  /** Länge des Gesprächsverlaufs vor der Ruhemodus-Ansage – kürzt sie beim Wecken weg. */
  private chatLengthBeforeWarning: number | null = null;

  /** Während der Ruhemodus-Ansage darf der User die KI nicht unterbrechen. */
  private get isProtectedResponse(): boolean {
    return this.dormancyPhase !== "none" && this.dormancyPhase !== "dormant";
  }

  // #endregion

  // #region Reconnect (Zustand)
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // #endregion

  // #region Gespräch & Chat (siehe conversation/Conversation.ts, ui/ChatView.ts)
  /** Chat-Verlauf und Transkript – wird in renderUI() angelegt. */
  private conversation!: Conversation<HTMLDivElement>;
  private chatView!: ChatView;

  // #endregion

  // #region Event-Log (siehe ui/EventLog.ts)
  private eventLog = new EventLog();
  private loggedInit = false;

  // #endregion

  // #region Konfiguration (aus Power Apps Properties)
  private config: ControlConfig = { ...INITIAL_CONFIG };

  // #endregion

  // #region Session-Token (kommt aus der App, siehe session/sessionToken.ts)
  private sessionToken = new SessionTokenRequester();
  private events: ComponentFramework.Context<IInputs>["events"] | null = null;

  // #endregion

  // #region DOM-Referenzen
  private orbEl!: HTMLDivElement;
  private statusTextEl!: HTMLParagraphElement;
  private statusHeaderEl!: HTMLSpanElement;
  private muteBtn!: HTMLButtonElement;
  private connectBtn!: HTMLButtonElement;

  // #endregion

  // #endregion

  // #region Lebenszyklus (PCF)

  constructor() {
    /* Pflicht-Konstruktor für das PCF-Framework */
  }

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this.container = container;
    this.notifyOutputChanged = notifyOutputChanged;
    this.renderUI();
    this.updateView(context);
  }

  private renderUI(): void {
    const ui = renderTemplate(this.container);

    this.orbEl = ui.orb;
    this.statusTextEl = ui.statusText;
    this.statusHeaderEl = ui.statusHeader;
    this.muteBtn = ui.muteBtn;
    this.connectBtn = ui.connectBtn;

    this.visualizer = new Visualizer(
      ui.orb,
      ui.vuBars,
      () => this.audio.analyser,
      () => this.isMuted,
      () => this.controlState === "user-speaking",
    );

    this.chatView = new ChatView(this.container, ui.chatPanel, ui.chatMessages);
    this.conversation = new Conversation(this.chatView);

    ui.chatToggleBtn.addEventListener("click", () => this.chatView.toggle());

    // Das Panel ist der einzige Scroll-Container (.ai-chat-messages scrollt
    // nicht). Ein scroll-Listener deckt Maus, Touch und Tastatur gleichermaßen ab.
    ui.chatPanel.addEventListener("scroll", () => this.chatView.onScroll());

    this.muteBtn.addEventListener("click", () => this.toggleMute());
    this.connectBtn.addEventListener("click", () => this.toggleConnection());

    // Notbremse gegen den Ruhemodus: Ein Tippen irgendwo auf das Control zeigt,
    // dass jemand da ist. pointerdown deckt Maus und Touch ab und reagiert
    // sofort – bei einem Fenster von wenigen Sekunden zählt das.
    this.container.addEventListener("pointerdown", (e: PointerEvent) =>
      this.onContainerPointerDown(e),
    );

    this.container.className = "ai-voice-container state-idle";
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    // Ruhemodus: alten Wert merken – für den Kill-Switch weiter unten.
    const dormantWasEnabled = this.config.dormantEnabled;
    this.config = readConfig(context.parameters);

    // Session-Properties aus der App: Ein neuer Wert beantwortet die offene Anforderung
    // (siehe SessionTokenRequester). Ohne offene Anforderung wird er nur gemerkt.
    this.events = context.events;
    this.sessionToken.offer((context.parameters.SessionProperties.raw ?? "").trim());

    // Kill-Switch während einer laufenden Ansage: Ablauf sofort abbrechen.
    if (dormantWasEnabled && !this.config.dormantEnabled) {
      this.log("Ruhemodus deaktiviert – laufender Ablauf wird abgebrochen");
      this.abortDormancy();
    }

    if (!this.loggedInit) {
      this.loggedInit = true;
      this.log("Init");
    }

    const isActive = context.parameters.Connected.raw === true;

    if (isActive !== this.previousIsActive) {
      this.previousIsActive = isActive;

      this.log(
        `Connected=${isActive}, state=${this.controlState}`,
      );

      if (isActive && this.controlState === "idle") {
        void this.startSession();
      } else if (
        !isActive &&
        this.controlState !== "idle" &&
        this.controlState !== "reconnecting"
      ) {
        this.stopSession();
      }
    }
  }

  // #endregion

  // #region Zustand & Statusanzeige

  private setState(newState: ControlState, errorDetail?: string): void {
    this.controlState = newState;

    // Klassen, Texte und Button-Titel: siehe ui/statusView.ts
    const view = describeState({
      state: newState,
      chatOpen: this.chatView.isOpen,
      isMuted: this.isMuted,
      dormancyPhase: this.dormancyPhase,
      reconnectAttempt: this.reconnectAttempt,
      errorDetail,
    });

    this.container.className = view.className;

    if (this.statusTextEl) this.statusTextEl.textContent = view.statusText;

    if (this.statusHeaderEl) this.statusHeaderEl.textContent = view.header;

    if (this.connectBtn) this.connectBtn.title = view.connectTitle;

    if (this.orbEl) this.orbEl.style.transform = "";

    this.notifyOutputChanged();
  }

  /** Setzt den Status-Text f\u00fcr einen aktiven Tool-Aufruf (ohne State-Wechsel) */
  private setToolStatus(toolName: string, args?: string): void {
    const text = getToolDisplayText(toolName, args);
    if (this.statusTextEl && (this.controlState === "ai-thinking" || this.controlState === "ai-speaking")) {
      this.statusTextEl.textContent = text;
    }
    this.log(`Tool-Status: ${text}`);
  }

  // #endregion

  // #region Ruhemodus (Inaktivität → Dormant)
  //
  // Ohne MCP-Tool-Aufrufe wird die Anwendung nicht produktiv genutzt. Reines
  // Sprechen taugt bewusst NICHT als Aktivitätssignal – sonst würden fremde
  // Gespräche im Raum die Session offen halten, genau das soll verhindert
  // werden. Nach Ablauf der Frist kündigt die KI den Ruhemodus unterbrechungs-
  // fest an; kurz nach dem Ende der Ansage wird die Verbindung getrennt.

  /** Setzt die Inaktivitätsmessung zurück (echte Nutzung erkannt). */
  private resetIdleTimer(): void {
    this.lastToolCallAt = Date.now();
    this.deferredSince = null;
  }

  /** Merkt Gesprächsaktivität für das Quiet-Gate – KEIN Reset der Frist. */
  private markConversationActivity(): void {
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
  private noteToolActivity(): void {
    this.markConversationActivity();

    if (this.dormancyPhase !== "none") return;

    this.resetIdleTimer();
  }

  /** Startet die periodische Inaktivitätsprüfung (idempotent). */
  private startIdleWatch(): void {
    if (this.idleCheckTimer !== null) return;

    this.idleCheckTimer = setInterval(
      () => this.onIdleTick(),
      IDLE_CHECK_INTERVAL_MS,
    );
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
    if (!this.config.dormantEnabled) return;
    if (this.dormancyPhase !== "none") return;
    if (this.controlState !== "listening") return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.isCancelling) return;

    if (Date.now() - this.lastToolCallAt < this.config.idleTimeoutMs) return;

    // Quiet-Gate: speech_stopped setzt sofort "listening", response.created
    // folgt erst einige hundert ms später. Eine Ansage in dieses Fenster
    // würde als zweite Response kollidieren (conversation_already_has_active_response).
    const quietFor = Date.now() - this.lastConversationAt;
    if (quietFor < QUIET_GATE_MS) {
      if (this.deferredSince === null) {
        this.deferredSince = Date.now();
        this.log("Ruhemodus-Ansage aufgeschoben – Gespräch noch aktiv");
      } else if (
        Date.now() - this.deferredSince >= MAX_DEFER_MS
      ) {
        this.log("Ruhemodus-Ansage wird trotz Aktivität erzwungen");
        this.triggerDormancyWarning();
      }
      return;
    }

    this.triggerDormancyWarning();
  }

  /** Lässt die KI den Ruhemodus ankündigen – unterbrechungsfest. */
  private triggerDormancyWarning(): void {
    this.log("Inaktivität erkannt – kündige Ruhemodus an");

    // Ab hier sendet das Mikrofon nichts mehr (Gate in startMicrophone).
    // Ohne Upstream-Audio feuert das server-seitige VAD nicht, die Ansage
    // kann also weder client- noch serverseitig unterbrochen werden.
    this.dormancyPhase = "warning";
    this.deferredSince = null;

    // Merkt sich, wo der Verlauf endet – die Ansage selbst soll beim Aufwecken
    // nicht als Gesprächskontext zurückgespielt werden.
    this.chatLengthBeforeWarning = this.conversation.length;

    this.sendJson(userText(DORMANT_WARNING_PROMPT));
    this.sendJson({ type: "response.create" });

    // Not-Aus, falls die Ansage nie beantwortet wird oder kein Audio kommt.
    this.warningWatchdogTimer = setTimeout(() => {
      this.warningWatchdogTimer = null;
      this.log("Watchdog: Ansage blieb aus – gehe trotzdem in den Ruhemodus");
      this.enterDormantMode();
    }, WARNING_WATCHDOG_MS);
  }

  /**
   * Ersetzt den Watchdog durch eine berechnete Frist, sobald die Länge der
   * Ansage bekannt ist.
   *
   * Deckt den Fall ab, dass onended nie feuert – etwa wenn der AudioContext im
   * Hintergrund-Tab suspendiert wird. Der Ruhemodus greift dann trotzdem:
   * Ist die Ansage nicht hörbar, ist der Benutzer erst recht nicht da.
   */
  private armDormantBackupTimer(): void {
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    const remainingPlaybackMs = this.audio.remainingPlaybackMs;

    const deadline = remainingPlaybackMs + this.config.dormantDelayMs + 2000;

    this.warningWatchdogTimer = setTimeout(() => {
      this.warningWatchdogTimer = null;
      this.log("Playback-Ende blieb aus – gehe trotzdem in den Ruhemodus");
      this.enterDormantMode();
    }, deadline);
  }

  /** Ansage ist verklungen – kurze Nachlaufzeit, dann trennen. */
  private armDormantDelay(): void {
    if (this.dormancyPhase !== "warning") return;

    // Wer schon während der Ansage getippt hat, bekommt gar keinen Countdown.
    if (this.cancelRequestedDuringWarning) {
      this.pendingDormantTransition = false;
      this.cancelDormancy();

      return;
    }

    this.dormancyPhase = "pending-dormant";
    this.pendingDormantTransition = false;
    this.container.classList.add("dormant-pending");

    // Der Not-Aus hat seinen Zweck erfüllt – ab hier zählt nur noch die Nachlaufzeit.
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    if (this.dormantCountdownTimer !== null) {
      clearInterval(this.dormantCountdownTimer);
    }

    let remaining = Math.round(this.config.dormantDelayMs / 1000);
    this.log(`Ansage beendet – Ruhemodus in ${remaining}s`);

    // Erste Anzeige sofort, nicht erst nach der ersten Sekunde – sonst bliebe
    // eine Sekunde lang der alte Statustext stehen.
    this.showDormantCountdown(remaining);

    this.dormantCountdownTimer = setInterval(() => {
      remaining--;

      if (remaining <= 0) {
        if (this.dormantCountdownTimer !== null) {
          clearInterval(this.dormantCountdownTimer);
          this.dormantCountdownTimer = null;
        }
        this.enterDormantMode();
        return;
      }

      this.showDormantCountdown(remaining);
    }, 1000);
  }

  /**
   * Schreibt den Countdown direkt in den Statustext.
   *
   * Bewusst nicht über setState: Das würde den Text beim nächsten
   * Zustandswechsel überschreiben (gleiches Muster wie setToolStatus).
   */
  private showDormantCountdown(seconds: number): void {
    if (!this.statusTextEl) return;

    const unit = seconds === 1 ? "Sekunde" : "Sekunden";
    this.statusTextEl.textContent = `Ruhemodus in ${seconds} ${unit}…`;
  }

  /** Trennt die Verbindung, behält aber den Gesprächskontext. */
  private enterDormantMode(): void {
    if (this.controlState === "idle" || this.controlState === "dormant") return;

    this.log("Ruhemodus aktiv – Verbindung getrennt, Mikrofon aus");

    // Die Abschiedsansage aus dem Kontext nehmen, bevor cleanupConnection()
    // über abortDormancy() den Merker verwirft. Die Chat-Blase bleibt sichtbar,
    // sie wird beim Aufwecken nur nicht als Gesprächsverlauf zurückgespielt.
    if (
      this.chatLengthBeforeWarning !== null &&
      this.chatLengthBeforeWarning < this.conversation.length
    ) {
      this.conversation.truncate(this.chatLengthBeforeWarning);
    }

    // Verhindert, dass onclose einen Auto-Reconnect auslöst.
    this.intentionalClose = true;
    this.reconnectAttempt = 0;

    // cleanupConnection() ruft abortDormancy() – deshalb erst danach die
    // Phase auf "dormant" setzen, sonst wird sie sofort wieder überschrieben.
    this.cleanupConnection();

    this.dormancyPhase = "dormant";
    this.setState("dormant");
  }

  /**
   * Bricht einen laufenden Ruhemodus-Ablauf ab (Verbindungsabbruch, Fehler,
   * manuelles Trennen, Kill-Switch).
   *
   * lastToolCallAt bleibt bewusst unangetastet: Die Inaktivität endet nicht
   * dadurch, dass die Verbindung neu aufgebaut wurde. Kommt die Session zurück,
   * löst der nächste Tick die Ansage erneut aus.
   */
  private abortDormancy(): void {
    if (this.warningWatchdogTimer !== null) {
      clearTimeout(this.warningWatchdogTimer);
      this.warningWatchdogTimer = null;
    }

    if (this.dormantCountdownTimer !== null) {
      clearInterval(this.dormantCountdownTimer);
      this.dormantCountdownTimer = null;
    }

    this.pendingDormantTransition = false;
    this.chatLengthBeforeWarning = null;
    this.cancelRequestedDuringWarning = false;
    this.container.classList.remove("dormant-pending");

    // "dormant" ist ein Ruhezustand, kein laufender Ablauf – nicht zurücksetzen.
    if (this.dormancyPhase !== "dormant" && this.dormancyPhase !== "none") {
      this.log("Ruhemodus-Ablauf abgebrochen");
      this.dormancyPhase = "none";
    }
  }

  /**
   * Tippen irgendwo auf das Control während des Ruhemodus-Ablaufs.
   *
   * Der Connect-Button ist ausgenommen – er behält seine Trennen-Funktion,
   * damit derselbe Knopf nicht je nach Zeitpunkt Gegenteiliges tut.
   */
  private onContainerPointerDown(e: PointerEvent): void {
    if (this.dormancyPhase !== "warning" && this.dormancyPhase !== "pending-dormant") {
      return;
    }

    const target = e.target as Element | null;
    if (target?.closest(".ai-voice-connect-btn")) return;

    if (this.dormancyPhase === "pending-dormant") {
      this.cancelDormancy();
      return;
    }

    // Während der Ansage läuft noch eine Response – ein sofortiger Abbruch
    // bräuchte ein zweites response.create und würde kollidieren. Also nur
    // vormerken; armDormantDelay() wertet es aus, sobald die Ansage durch ist.
    if (!this.cancelRequestedDuringWarning) {
      this.cancelRequestedDuringWarning = true;
      this.log("Abbruch während der Ansage vorgemerkt");
    }
  }

  /**
   * Der Benutzer hat sich gemeldet – Ruhemodus abblasen, Verbindung behalten.
   *
   * Anders als abortDormancy() wird die Inaktivitätsfrist hier zurückgesetzt.
   * Das ist die bewusste Ausnahme von "nur MCP-Tool-Calls zählen": Ein Tippen
   * ist ein eindeutiger Anwesenheitsnachweis, Geräusch im Raum wäre es nicht.
   * Ohne den Reset würde der nächste Tick die Ansage sofort erneut auslösen.
   */
  private cancelDormancy(): void {
    this.log("Ruhemodus durch Benutzer abgebrochen");

    this.abortDormancy();
    this.resetIdleTimer();
    this.markConversationActivity();

    // Überschreibt den Countdown-Text mit dem normalen Status.
    this.setState("listening");

    this.sendJson(userText(DORMANT_CANCEL_PROMPT));
    this.sendJson({ type: "response.create" });
  }

  /** Weckt eine schlafende Session wieder auf – mit Gesprächskontext. */
  private wakeFromDormant(): void {
    this.log("Ruhemodus wird beendet – Session wird fortgesetzt");

    this.dormancyPhase = "none";
    this.reconnectAttempt = 0;

    // Ohne Reset läge der Zeitstempel weiterhin jenseits der Frist und der
    // erste Tick würde die frisch geweckte Session sofort wieder schlafen legen.
    this.resetIdleTimer();
    this.markConversationActivity();

    // Die Rückmeldung wird in startSession() angestoßen – gemeinsam mit dem
    // Reconnect-Pfad, damit beide identisch laufen.
    //
    // greetingSent bleibt true: Sonst würden Begrüßungs- und Resume-Response
    // gleichzeitig laufen (conversation_already_has_active_response).
    void this.startSession("wake");
  }

  // #endregion

  // #region Session-Aufbau & Reconnect

  /**
   * Spielt den bisherigen Gesprächsverlauf in eine frische Session ein.
   * Aufbau und Reihenfolge der Items: siehe historyItems() in agent/messages.ts.
   */
  private injectConversationHistory(noticeText: string): void {
    const { items, historyCount } = historyItems(this.conversation.history, noticeText);

    for (const item of items) this.sendJson(item);

    this.log(`${historyCount} Konversations-Items injiziert`);
  }

  /**
   * Startet eine neue Voice Live Session:
   *   1. Baut die WebSocket-Verbindung zum Proxy auf (`/api/voice-live/ws`)
   *   2. Konfiguriert die Session (Semantic VAD, Noise Suppression, Echo Cancellation, Azure STT)
   *   3. Startet das Mikrofon
   *
   * `mode` steuert, ob dabei der Gesprächsverlauf erhalten bleibt – siehe
   * `SessionStartMode` und `keepsContext` weiter unten.
   */
  private async startSession(mode: SessionStartMode = "new"): Promise<void> {
    this.intentionalClose = false;

    // Nur beim automatischen Reconnect bleibt der Zähler stehen – ein
    // frischer Start und das Aufwecken beginnen wieder bei null.
    if (mode !== "reconnect") {
      this.reconnectAttempt = 0;
    }

    // Der Verlauf wird sowohl beim Reconnect als auch beim Aufwecken erhalten.
    const keepsContext = mode !== "new";

    this.setState(mode === "reconnect" ? "reconnecting" : "connecting");

    try {
      // Session-Token und Backend-Endpunkt von der App holen. Sie ruft den Custom Connector, der den Nutzer
      // anmeldet; das Backend prüft dabei Token und Ziel (Agent + Dataverse-Org). Agent-Parameter und Nutzer
      // stehen im Token, nicht in der WebSocket-URL. Ohne Token gibt es keine Session.
      // Das Backend in der Function App übernimmt die Auth gegenüber Azure und Dataverse.
      const { accessToken, endpoint } = await this.sessionToken.request(
        this.events?.OnTokenNeeded,
      );

      const wsUrl = `${endpoint}?access_token=${encodeURIComponent(accessToken)}`;

      this.log(`WebSocket öffnet: ${endpoint}`);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.log(
          mode === "reconnect"
            ? `WebSocket reconnected (Versuch ${this.reconnectAttempt})`
            : mode === "wake"
              ? "WebSocket nach Ruhemodus geöffnet, sende session.update..."
              : "WebSocket geöffnet, sende session.update...",
        );

        this.reconnectAttempt = 0;

        // Die Frist startet beim Verbindungsaufbau – sonst würde der
        // Initialwert 0 gleich beim ersten Tick feuern.
        //
        // Beim Reconnect NICHT zurücksetzen: Ein Verbindungsabbruch ist keine
        // produktive Nutzung, nur MCP-Tool-Aufrufe verlängern die Frist.
        if (mode !== "reconnect") {
          this.resetIdleTimer();
        }

        this.markConversationActivity();

        if (!keepsContext) {
          this.conversation.resetForNewSession();

          // Ein frischer Start begrüßt neu – eine evtl. noch gesetzte
          // Rückmeldung aus einer abgebrochenen Sitzung gilt nicht mehr.
          this.pendingResumeResponse = false;

          this.conversation.clear();
        }
        this.mcpFollowUpPending = false;

        // Aufbau und Hintergründe: siehe buildSessionPayload() in agent/messages.ts.
        const sessionPayload = buildSessionPayload(this.config);

        // session.update MUSS als allererste Nachricht kommen –
        // der Server erwartet es als Session-Konfiguration.
        this.sendJson({ type: "session.update", session: sessionPayload });
        this.log("session.update gesendet");

        // Bisherigen Gesprächsverlauf als Konversations-Items injizieren
        // (NACH session.update – sonst "max_config_attempts_exceeded")
        if (keepsContext) {
          this.injectConversationHistory(
            mode === "wake"
              ? DORMANT_RESUME_PROMPT
              : RECONNECT_RESUME_PROMPT,
          );

          // Beide Hinweistexte fordern eine kurze Rückmeldung – ausgelöst wird
          // sie erst bei session.created, sonst überholt sie die Session-Konfig.
          this.pendingResumeResponse = true;
        }

        this.log("Starte Mikrofon...");
        void this.startMicrophone();
        this.startIdleWatch();
        this.setState("listening");
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerEvent;

          this.handleServerEvent(msg);
        } catch {
          /* ignore malformed frames */
        }
      };

      this.ws.onerror = () => {
        // Nicht cleanup() aufrufen – onclose feuert immer danach und hat den Close-Code

        this.log(
          "WebSocket onerror ausgelöst – warte auf onclose für Details...",
        );
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.log(
          `WebSocket geschlossen: Code=${event.code} Reason="${event.reason || "(kein)"}"`,
        );

        const wasActive =
          this.controlState !== "idle" && this.controlState !== "error";

        const reason = closeCodeToMessage(event.code, event.reason);

        // Reconnect bei unerwartetem Verbindungsabbruch (Netzwerkfehler o.ä.).
        // Der Ausnahmefall – die Session läuft sonst unbegrenzt, das Backend
        // hält sie offen.

        const isRecoverable = isRecoverableClose({
          intentionalClose: this.intentionalClose,
          wasActive,
          code: event.code,
          attempt: this.reconnectAttempt,
        });

        this.cleanupConnection(); // WS + Audio aufräumen, Chat behalten

        if (isRecoverable) {
          this.attemptReconnect();
        } else if (wasActive && !this.intentionalClose) {
          this.setState("error", reason);
        } else if (!this.intentionalClose) {
          this.setState(
            "error",
            reason || "WebSocket-Fehler – Endpoint oder Token prüfen",
          );
        }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      this.log(`startSession Fehler: ${msg}`);

      this.setState("error", `Fehler: ${msg}`);
    }
  }

  /** Wartet mit exponentiellem Backoff und startet dann eine neue Session. */
  private attemptReconnect(): void {
    this.reconnectAttempt++;

    const delay = backoffDelay(this.reconnectAttempt);

    this.setState("reconnecting");

    this.log(
      `Reconnect ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      void this.startSession("reconnect");
    }, delay);
  }

  // #endregion

  // #region Server-Events

  /**
   * Verarbeitet eingehende Events vom Voice Live Server.
   *
   * Kompatible Events (identisch zur Realtime API):
   *   - input_audio_buffer.speech_started/stopped
   *   - response.created / response.audio.delta / response.done
   *   - response.audio_transcript.delta / .done
   *   - conversation.item.input_audio_transcription.completed
   *   - error
   *   - conversation.item.input_audio_transcription.delta (Streaming User-Transkript)
   *   - warning (informational, session bleibt offen)
   */
  private handleServerEvent(msg: ServerEvent): void {
    this.log(`← ${msg.type}`);

    switch (msg.type) {
      case "session.created":
        this.log("Session erfolgreich konfiguriert");
        if (!this.greetingSent) {
          this.sendJson(userText(greetingPrompt(this.config.userName)));
          this.sendJson({ type: "response.create" });
          this.greetingSent = true;
        } else if (this.pendingResumeResponse) {
          // Nach Reconnect oder Aufwecken: Der Verlauf wurde in onopen bereits
          // injiziert, hier wird nur die Rückmeldung angestoßen. Nicht aus
          // onopen senden – das würde session.created vorausrasen.
          this.pendingResumeResponse = false;
          this.sendJson({ type: "response.create" });
          this.log("Rückmeldung nach Wiederverbinden angefordert");
        }
        break;

      case "input_audio_buffer.speech_started": {
        // Die Ruhemodus-Ansage darf nicht unterbrochen werden. Das Mikrofon-Gate
        // verhindert das bereits an der Quelle – dieser Guard ist die zweite
        // Absicherung und muss vor jedem Teardown stehen.
        if (this.isProtectedResponse) {
          this.log("Barge-In während Ruhemodus-Ansage ignoriert");
          break;
        }

        const wasAiSpeaking = this.controlState === "ai-speaking" || this.controlState === "ai-thinking";

        this.log(
          `User unterbricht (Barge-In) – wasAiSpeaking=${wasAiSpeaking}`,
        );

        // 1. Client-Audio SOFORT hart stoppen (wichtig für die UX im Auto!)
        this.pendingListeningTransition = false; // Barge-In überschreibt ausstehende Transition
        this.audio.stopPlayback();

        // 2. Timeline für die nächste Response zurücksetzen
        this.audio.resetTimeline();

        // 3. Den Server abbrechen – VOR setState, da controlState sich ändert!
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          wasAiSpeaking &&
          !this.isCancelling
        ) {
          this.isCancelling = true;

          this.log("Sende response.cancel an den Server");

          this.sendJson({ type: "response.cancel" });

          // Fail-Safe: Wenn der Server nicht antwortet, geben wir den State nach 2s wieder frei
          setTimeout(() => {
            this.isCancelling = false;
          }, 2000);
        }

        // 4. Erst NACH dem Cancel den State wechseln
        this.conversation.resetUserStreaming();
        this.setState("user-speaking");
        break;
      }

      case "input_audio_buffer.speech_stopped":
        this.markConversationActivity();
        // Während der Ruhemodus-Ansage nicht auf "listening" zurückfallen –
        // das würde den Countdown-Text überschreiben.
        if (!this.isProtectedResponse) {
          this.setState("listening");
        }
        break;

      case "response.created":
        this.markConversationActivity();
        this.conversation.beginAiResponse();
        this.setState("ai-thinking");
        break;

      // ── MCP Tool-Call Events ─────────────────────────────────────
      case "response.output_item.added":
        if (msg.item?.type === "mcp_call" && msg.item.name) {
          this.currentToolName = msg.item.name;
          this.setToolStatus(msg.item.name);
          // Der Start des Aufrufs ist das verlässlichste Aktivitätssignal –
          // er feuert unabhängig davon, ob der Aufruf am Ende gelingt.
          this.noteToolActivity();
        }
        break;

      case "response.mcp_call.in_progress":
        break;

      case "response.mcp_call_arguments.delta":
        break;

      case "response.mcp_call_arguments.done":
        if (this.currentToolName && msg.arguments) {
          this.setToolStatus(this.currentToolName, msg.arguments);
        }
        break;

      case "response.mcp_call.completed":
        this.currentToolName = null;
        this.mcpFollowUpPending = true;
        this.noteToolActivity();
        break;

      case "mcp_list_tools.in_progress":
      case "mcp_list_tools.completed":
        break;

      case "session.updated": {
        // Bestätigt der Server Live-Reference AEC? Fehlt reference_source in
        // der Antwort, ist die API-Version des Proxys zu alt (nötig ab
        // 2026-07-15) – dann läuft die Echounterdrückung ohne unsere Referenz
        // und KoRa fällt sich beim Sprechen selbst ins Wort.
        if (USE_LIVE_REFERENCE_AEC) {
          const aec = msg.session?.audio?.input?.echo_cancellation;

          if (aec?.reference_source === "client") {
            this.log("Live-Reference AEC aktiv (Referenzkanal bestätigt)");
          } else {
            this.log(
              "WARNUNG: Live-Reference AEC NICHT bestätigt – Proxy braucht " +
                "api-version 2026-07-15 oder neuer. Mikrofon wird als Mono " +
                "gelesen, Schalter zurückstellen.",
            );
          }
        }
        break;
      }

      case "response.output_item.done":
      case "conversation.item.created":
      case "conversation.item.done":
      case "response.content_part.added":
      case "response.content_part.done":
      case "input_audio_buffer.committed":
      case "conversation.item.added":
      case "response.output_audio.done":
        // Bekannte Events ohne spezielle Behandlung
        break;

      case "response.output_audio.delta":
        // Erster Audio-Chunk: Wechsel von "denkt nach" zu "spricht"
        if (this.controlState === "ai-thinking") {
          this.setState("ai-speaking");
        }
        if (msg.delta && (this.controlState === "ai-speaking" || this.controlState === "ai-thinking"))
          this.audio.play(msg.delta);
        break;

      case "response.done":
        this.log("Server meldet response.done.");
        // Lock lösen
        this.isCancelling = false;

        // Voice Agent: Nach einem MCP-Aufruf beginnt das Modell die Antwort darauf nicht
        // von selbst (es bleibt bei "Einen Moment …"), sie muss angefordert werden.
        if (this.mcpFollowUpPending) {
          this.mcpFollowUpPending = false;
          this.log("MCP-Ergebnis liegt vor, fordere Antwort an");
          setTimeout(() => this.sendJson({ type: "response.create" }), 500);
        }
        if (this.conversation.commitAiTurn()) {
          this.notifyOutputChanged();
        }

        this.markConversationActivity();

        if (this.dormancyPhase === "warning") {
          // Die Ruhemodus-Ansage ist fertig formuliert. Bewusst KEIN
          // pendingListeningTransition – sonst würde das letzte onended erst
          // auf "listening" schalten (grüner Verbunden-Punkt) und dann trennen.
          if (this.audio.activeCount > 0) {
            this.pendingDormantTransition = true;
            this.log(
              `Ruhemodus-Ansage: ${this.audio.activeCount} Audio-Chunks laufen noch`,
            );
            this.armDormantBackupTimer();
          } else {
            // Ansage ohne Audio (Textantwort, leer beendete Response).
            this.armDormantDelay();
          }
          break;
        }

        // Auf 'listening' wechseln – aber nur wenn kein Audio mehr im Playback-Buffer ist.
        // Falls noch Chunks abgespielt werden, warten wir auf das letzte onended.
        if (this.controlState === "ai-speaking" || this.controlState === "ai-thinking") {
          if (this.audio.activeCount > 0) {
            this.pendingListeningTransition = true;
            this.log(`response.done: ${this.audio.activeCount} Audio-Chunks noch im Playback – warte auf Ende`);
          } else {
            this.setState("listening");
          }
        }
        break;

      // ── Transkriptions-Events ────────────────────────────────────
      // Voice Live: Streaming User-Transkript (Wort für Wort)
      case "conversation.item.input_audio_transcription.delta":
        if (msg.delta) {
          this.conversation.appendUserDelta(msg.delta);
        }
        break;

      // Finales User-Transkript (kompatibel mit Realtime API)
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) {
          this.conversation.completeUser(msg.transcript);
          this.notifyOutputChanged();
        }
        break;

      // KI-Transkript (Streaming)
      case "response.output_audio_transcript.delta":
        if (msg.delta) {
          this.conversation.appendAiDelta(msg.delta);
        }

        break;

      case "response.output_audio_transcript.done":
        if (msg.transcript) {
          this.conversation.setAiFinal(msg.transcript);
        }

        break;

      // Voice Live: Warnungen (informational, Session bleibt offen)
      case "warning":
        // Intentionally ignored – warnings don't interrupt the session
        break;

      case "error": {
        const errMsg = msg.error?.message || "Unbekannt";

        const errCode =
          (msg.error as Record<string, unknown>)?.code || "Kein Code";

        this.log(`WARNUNG (Server Error): [${errCode}] ${errMsg}`);

        if (
          errMsg.includes("cancelled") ||
          errMsg.includes("interrupted") ||
          errCode === "1011"
        ) {
          this.log(
            "Fehler als harmlose Race-Condition eingestuft. Ignoriere...",
          );

          this.isCancelling = false;

          break;
        }

        // Echter Fehler: Ein laufender Ruhemodus-Ablauf würde sonst mit
        // stummem Mikrofon hängen bleiben.
        this.abortDormancy();

        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.setState("error", errMsg);
        }

        break;
      }
    }
  }

  // #endregion

  // #region Audio (siehe audio/AudioEngine.ts, audio/Visualizer.ts)

  /** Startet Mikrofon und Visualisierung; ein Fehler landet in der Statusanzeige. */
  private async startMicrophone(): Promise<void> {
    const error = await this.audio.startMicrophone();

    if (error) {
      this.log(`FEHLER (Mikrofon): ${error}`);
      this.setState("error", error);
      return;
    }

    this.visualizer.start();
  }

  /** Der letzte Antwort-Chunk ist verklungen. */
  private onPlaybackDrained(): void {
    // Letzter Chunk fertig abgespielt → jetzt auf 'listening' wechseln
    if (this.pendingListeningTransition) {
      this.pendingListeningTransition = false;
      if (this.controlState === "ai-speaking") {
        this.setState("listening");
      }
    }

    // Ruhemodus-Ansage ist verklungen → Nachlaufzeit starten
    if (this.pendingDormantTransition) {
      this.pendingDormantTransition = false;
      if (this.dormancyPhase === "warning") {
        this.armDormantDelay();
      }
    }
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // #endregion

  // #region Event-Log

  private log(msg: string): void {
    this.eventLog.log(msg);
  }

  // #endregion

  // #region Steuerung & Abbau

  private toggleConnection(): void {
    // Aus dem Ruhemodus heraus weckt der Button auf, statt zu trennen.
    if (this.controlState === "dormant") {
      this.log("Connect-Button: Beende Ruhemodus...");
      this.wakeFromDormant();

      return;
    }

    const currentlyActive =
      this.controlState !== "idle" &&
      this.controlState !== "error" &&
      this.controlState !== "reconnecting";

    if (currentlyActive || this.controlState === "reconnecting") {
      this.log("Connect-Button: Trenne Verbindung...");
      this.stopSession();
    } else {
      this.log("Connect-Button: Starte Verbindung...");
      this.greetingSent = false;
      void this.startSession();
    }
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.muteBtn.classList.toggle("muted", this.isMuted);
    this.muteBtn.title = this.isMuted
      ? "Stummschaltung aufheben"
      : "Mikrofon stummschalten";

    this.log(`Mikrofon ${this.isMuted ? "stummgeschaltet" : "aktiviert"}`);

    if (this.isMuted && this.controlState === "user-speaking") {
      this.log(
        "Mute während Sprechen: Commit + Response erzwingen",
      );
      // Audio-Puffer abschließen und explizit KI-Antwort anfordern
      this.sendJson({ type: "input_audio_buffer.commit" });
      this.sendJson({ type: "response.create" });
      this.setState("listening");
    } else {
      // Container-Klasse aktualisieren (muted-Zustand für CSS)
      this.container.classList.toggle("muted", this.isMuted);
    }
  }

  /** Vollständiger Ausstieg: cleanup() + Ruhemodus-Status zurücksetzen, State → idle. */
  private stopSession(): void {
    this.intentionalClose = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    this.reconnectAttempt = 0;
    this.cleanup();

    // Vollständiger Ausstieg – auch aus dem Ruhemodus heraus. abortDormancy()
    // lässt "dormant" bewusst stehen, hier muss die Phase aber weg, sonst
    // blockiert sie die Inaktivitätsprüfung der nächsten Session.
    this.dormancyPhase = "none";
    this.pendingResumeResponse = false;
    this.chatLengthBeforeWarning = null;

    this.setState("idle");
  }

  /** Räumt nur WS + Audio auf, behält Chat/Transkript für Reconnect. */
  private cleanupConnection(): void {
    // Zentraler Aufräumpunkt für alle Ruhemodus-Timer: deckt Verbindungsabbruch,
    // manuelles Trennen und destroy() in einem Zug ab. Ohne das würde ein
    // laufendes Intervall nach der Zerstörung notifyOutputChanged() aufrufen.
    if (this.idleCheckTimer !== null) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    this.abortDormancy();

    this.visualizer.stop();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }

    // Sitzungs-Graph abbauen – der AudioContext selbst bleibt (siehe AudioEngine).
    this.audio.teardownSession();

    this.visualizer.reset();

    this.audio.stopPlayback();

    this.pendingListeningTransition = false;
    this.pendingDormantTransition = false;
  }

  /** cleanupConnection() + Reconnect-Timer stoppen – gemeinsamer Kern von stopSession() und destroy(). */
  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupConnection();
  }

  // #endregion

  // #region PCF-Outputs & Zerstörung

  public getOutputs(): IOutputs {
    return {
      // "dormant" meldet bewusst weiterhin Connected=true: Die Property ist
      // bidirektional gebunden. Ein false würde Power Apps zurückschreiben
      // lassen, updateView würde stopSession() aufrufen und den Weck-Pfad
      // zerstören. Den echten Zustand liefert ConnectionStatus.
      Connected: this.controlState !== "idle" && this.controlState !== "error",
      ConnectionStatus: this.controlState,
      Transcript: this.conversation.transcript,
      EventLog: this.eventLog.text,
    };
  }

  public destroy(): void {
    this.cleanup();

    // Der AudioContext überlebt bewusst einzelne Verbindungen. Beim Zerstören
    // des Controls muss er aber wirklich geschlossen werden (siehe
    // AudioEngine.dispose()).
    this.audio.dispose();
  }

  // #endregion
}
