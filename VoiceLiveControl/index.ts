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
  ChatMessage,
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
  TOKEN_WAIT_MS,
  USE_LIVE_REFERENCE_AEC,
  WARNING_WATCHDOG_MS,
  readConfig,
} from "./config";
import {
  DORMANT_CANCEL_PROMPT,
  DORMANT_RESUME_PROMPT,
  DORMANT_WARNING_PROMPT,
  HISTORY_PREAMBLE_PROMPT,
  RECONNECT_RESUME_PROMPT,
  greetingPrompt,
} from "./agent/prompts";
import { getToolDisplayText } from "./agent/toolStatus";
import {
  VOICE_LIVE_SAMPLE_RATE,
  base64Pcm16ToFloat32,
  bufferToBase64,
  float32ToPcm16,
  interleave,
  resample,
} from "./audio/pcm";
import { WORKLET_CODE } from "./audio/workletCode";
import {
  backoffDelay,
  closeCodeToMessage,
  isRecoverableClose,
} from "./session/reconnect";

export class VoiceLiveControl implements ComponentFramework.StandardControl<
  IInputs,
  IOutputs
> {
  // #region Felder

  // #region Infrastruktur
  private container!: HTMLDivElement;
  private notifyOutputChanged!: () => void;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  /**
   * Quellknoten des Mikrofons. Muss als Feld geführt werden, weil nur er selbst
   * seine ausgehenden Kanten lösen kann – der AudioContext überlebt einzelne
   * Verbindungen und würde die Knoten sonst über die Sitzung hinaus behalten.
   */
  private micSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * Sammelpunkt der Wiedergabe. Alle Antwort-Chunks laufen hierüber, weil der
   * Bus zwei Abnehmer hat: die Lautsprecher und – als Echo-Referenz für die
   * serverseitige Entzerrung – Eingang 1 des Mikrofon-Worklets.
   */
  private playbackBus: GainNode | null = null;
  private animationFrameId: number | null = null;
  private nextPlayTime = 0;
  private controlState: ControlState = "idle";
  private previousIsActive: boolean | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
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
  /** Länge von chatMessages vor der Ruhemodus-Ansage – kürzt sie beim Wecken weg. */
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

  // #region Transkript
  private transcriptText = "";
  private eventLogText = "";
  private currentAiTranscript = "";
  private currentUserTranscript = "";

  // #endregion

  // #region Chat-UI (Zustand)
  private chatMessages: ChatMessage[] = [];
  private chatOpen = false;
  /** Folgt der Chat dem Verlauf? Pausiert, sobald der Nutzer hochscrollt. */
  private chatAutoScroll = true;
  /** Trennt eigene Scroll-Aufrufe von echten Nutzergesten. */
  private isProgrammaticScroll = false;

  /**
   * Abstand zum Ende, ab dem der Nutzer noch als "liest mit" gilt.
   *
   * Misst bewusst NICHT das Wachstum des Inhalts – genau daran ist die
   * frühere Heuristik gescheitert, als die Bubbles größer wurden als ihr
   * Schwellwert. Hier geht es nur um die Ruheposition des Nutzers, der Wert
   * ist damit unabhängig von Schriftgröße und Bubble-Höhe.
   */
  private static readonly CHAT_BOTTOM_THRESHOLD_PX = 48;
  // #endregion

  // #region Event-Log (Felder)
  // UI-Panel dafür ist im Markup auskommentiert (siehe renderUI) – eventLogEl
  // bleibt entsprechend ungesetzt, der DOM-Zweig in log() bleibt inaktiv.
  private eventLogEntries: string[] = [];
  private eventLogEl!: HTMLDivElement;
  private loggedInit = false;

  // #endregion

  // #region Konfiguration (aus Power Apps Properties)
  private config: ControlConfig = { ...INITIAL_CONFIG };

  // #endregion

  // #region Session-Token (kommt aus der App)
  // Das Control hat kein Entra-Token. Die App ruft den Custom Connector „KoRa VoiceLive“ (er meldet den Nutzer an
  // und schickt dessen Token an POST /api/voice-live/token) und liefert dessen Antwort als JSON über die
  // Property SessionProperties (access_token und endpoint, den WebSocket-Endpunkt des Backends).
  // Braucht das Control ein neues Token, löst es das Event OnTokenNeeded aus.
  // Schlägt der Aufruf in der App fehl, liefert sie statt des JSON "error:<eindeutiger Zusatz>:<Meldung>".
  // Der Zusatz (z. B. die Uhrzeit) sorgt dafür, dass sich der Wert bei jedem Fehler ändert, denn Power Apps
  // meldet dem Control nur Änderungen.
  private sessionProperties = "";
  private tokenWaiter: ((value: string) => void) | null = null;
  private events: ComponentFramework.Context<IInputs>["events"] | null = null;

  // #endregion

  // #region DOM-Referenzen
  private orbEl!: HTMLDivElement;
  private statusTextEl!: HTMLParagraphElement;
  private statusHeaderEl!: HTMLSpanElement;
  private vuBars!: HTMLDivElement[];
  private chatToggleBtn!: HTMLButtonElement;
  private chatPanel!: HTMLDivElement;
  private chatMessagesEl!: HTMLDivElement;
  private muteBtn!: HTMLButtonElement;
  private connectBtn!: HTMLButtonElement;
  private lastAiBubbleEl: HTMLDivElement | null = null;
  private lastUserBubbleEl: HTMLDivElement | null = null;

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
    this.container.innerHTML = `
            <div class="ai-voice-header">
                <div class="ai-voice-status-label">
                    <span class="ai-voice-status-dot"></span>
                    <span class="ai-voice-status-header">Nicht verbunden</span>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="ai-chat-toggle" title="Chat-Transkript anzeigen">
                    <!-- Zustand: Chat OFFEN → normale Sprechblase -->
                    <svg class="icon-chat-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <!-- Zustand: Chat GESCHLOSSEN → durchgestrichene Sprechblase -->
                    <svg class="icon-chat-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        <line x1="3" y1="3" x2="21" y2="21"/>
                    </svg>
                  </button>                    
                </div>
            </div>
            <div class="ai-voice-orb-area">
                <div class="ai-voice-orb-wrapper">
                    <div class="ai-voice-ring ai-voice-ring-1"></div>
                    <div class="ai-voice-ring ai-voice-ring-2"></div>
                    <div class="ai-voice-ring ai-voice-ring-3"></div>
                    <div class="ai-voice-orb">
                      <!--
                      <svg class="ai-voice-orb-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-1 14.93V19H9v2h6v-2h-2v-2.07A7.001 7.001 0 0 0 19 11h-2a5 5 0 0 1-10 0H5a7.001 7.001 0 0 0 6 6.93z"/>
                      </svg>
                      -->
                    </div>
                </div>
                <p class="ai-voice-status-text">Inaktiv</p>
                <p class="ai-voice-dormant-hint">Tippen zum Fortsetzen</p>
                <div class="ai-voice-vu-meter">
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                </div>
            </div>
            <div class="ai-chat-panel">
                <div class="ai-chat-messages">
                    <p class="ai-chat-empty">Gespr\u00e4ch starten, um Transkript zu sehen</p>
                </div>
            </div>
            <div class="ai-voice-footer">
                <button class="ai-voice-action-btn ai-voice-mute-btn" title="Mikrofon stummschalten">
                    <svg class="icon-mic-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                        <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                        <line x1="12" x2="12" y1="19" y2="22"/>
                    </svg>
                    <svg class="icon-mic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="2" x2="22" y1="2" y2="22"/>
                        <path d="M18.89 13.23A7.12 7.12 0 0 0 19 11v-1"/>
                        <path d="M5 10v1a6.93 6.93 0 0 0 1.39 4.19"/>
                        <path d="M9 10.5V5a3 3 0 0 1 5.14-2.12"/>
                        <path d="M12 18.5a6.95 6.95 0 0 1-3.6-1.02"/>
                        <line x1="12" x2="12" y1="19" y2="22"/>
                    </svg>
                </button>
                <div class="ai-voice-config-warning"></div>
                <button class="ai-voice-action-btn ai-voice-connect-btn" title="Verbindung herstellen">
                    <svg class="icon-waves" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="4" x2="12" y2="20"></line>
                        <line x1="6" y1="10" x2="6" y2="14"></line>
                        <line x1="18" y1="10" x2="18" y2="14"></line>
                    </svg>
                    <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <!--
            <div class="ai-event-log">
                <div class="ai-event-log-header">
                    <span>Event Log</span>
                    <div style="display:flex;gap:6px">
                        <button class="ai-event-log-clear" title="Log leeren">✕</button>
                        <button class="ai-event-log-toggle" title="Log ein-/ausklappen">▼</button>
                    </div>
                </div>
                <div class="ai-event-log-body"></div>
            </div>
            -->
        `;

    this.orbEl = this.container.querySelector(
      ".ai-voice-orb",
    ) as HTMLDivElement;

    this.statusTextEl = this.container.querySelector(
      ".ai-voice-status-text",
    ) as HTMLParagraphElement;

    this.statusHeaderEl = this.container.querySelector(
      ".ai-voice-status-header",
    ) as HTMLSpanElement;

    this.vuBars = Array.from(
      this.container.querySelectorAll(".ai-voice-bar"),
    ) as HTMLDivElement[];

    this.chatToggleBtn = this.container.querySelector(
      ".ai-chat-toggle",
    ) as HTMLButtonElement;

    this.chatPanel = this.container.querySelector(
      ".ai-chat-panel",
    ) as HTMLDivElement;

    this.chatMessagesEl = this.container.querySelector(
      ".ai-chat-messages",
    ) as HTMLDivElement;

    this.muteBtn = this.container.querySelector(
      ".ai-voice-mute-btn",
    ) as HTMLButtonElement;

    this.connectBtn = this.container.querySelector(
      ".ai-voice-connect-btn",
    ) as HTMLButtonElement;

    this.chatToggleBtn.addEventListener("click", () => this.toggleChat());

    // Das Panel ist der einzige Scroll-Container (.ai-chat-messages scrollt
    // nicht). Ein scroll-Listener deckt Maus, Touch und Tastatur gleichermaßen ab.
    this.chatPanel.addEventListener("scroll", () => this.onChatScroll());

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
    // (siehe requestSessionToken). Ohne offene Anforderung wird er nur gemerkt.
    this.events = context.events;
    const incoming = (context.parameters.SessionProperties.raw ?? "").trim();
    if (incoming && incoming !== this.sessionProperties) {
      this.sessionProperties = incoming;
      const waiter = this.tokenWaiter;
      this.tokenWaiter = null;
      waiter?.(incoming);
    }

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

    const classes = ["ai-voice-container"];

    classes.push(`state-${newState}`);

    if (["listening", "user-speaking", "ai-thinking", "ai-speaking"].includes(newState)) {
      classes.push("state-connected");
    }

    if (
      [
        "connecting",
        "reconnecting",
        "listening",
        "user-speaking",
        "ai-thinking",
        "ai-speaking",
      ].includes(newState)
    ) {
      classes.push("state-active");
    }

    if (this.chatOpen) {
      classes.push("chat-open");
    }

    if (this.isMuted) {
      classes.push("muted");
    }

    // className wird komplett neu gebaut – ein setState während des Countdowns
    // würde den Tipp-Hinweis sonst wegwischen.
    if (this.dormancyPhase === "pending-dormant") {
      classes.push("dormant-pending");
    }

    this.container.className = classes.join(" ");

    const labels: Record<ControlState, { text: string; header: string }> = {
      idle: { text: "Inaktiv", header: "Nicht verbunden" },

      connecting: { text: "Verbinde\u2026", header: "Verbinde\u2026" },

      reconnecting: {
        text: `Verbindung wiederherstellen (${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})\u2026`,
        header: "Verbindung unterbrochen",
      },

      listening: {
        text: "Ich h\u00f6re zu\u2026",
        header: "Verbunden",
      },

      "user-speaking": {
        text: "Du sprichst\u2026",
        header: "Verbunden",
      },

      "ai-thinking": {
        text: "KoRa denkt nach\u2026",
        header: "Verbunden",
      },

      "ai-speaking": {
        text: "KoRa spricht\u2026",
        header: "Verbunden",
      },

      dormant: {
        text: "Ruhemodus – zum Fortsetzen erneut verbinden",
        header: "Ruhemodus",
      },

      error: { text: errorDetail ?? "Verbindungsfehler", header: "Fehler" },
    };

    const info = labels[newState];

    // Bei Mute + Listening: angepassten Statustext zeigen
    if (this.statusTextEl) {
      this.statusTextEl.textContent =
        this.isMuted && newState === "listening"
          ? "Mikrofon stummgeschaltet"
          : info.text;
    }

    if (this.statusHeaderEl) this.statusHeaderEl.textContent = info.header;

    const isActive = [
      "connecting",
      "reconnecting",
      "listening",
      "user-speaking",
      "ai-thinking",
      "ai-speaking",
    ].includes(newState);

    if (this.connectBtn) {
      if (newState === "dormant") {
        this.connectBtn.title = "Ruhemodus beenden";
      } else {
        this.connectBtn.title = isActive
          ? "Verbindung trennen"
          : "Verbindung herstellen";
      }
    }

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
    this.chatLengthBeforeWarning = this.chatMessages.length;

    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: DORMANT_WARNING_PROMPT,
          },
        ],
      },
    });
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

    const remainingPlaybackMs = this.audioContext
      ? Math.max(0, this.nextPlayTime - this.audioContext.currentTime) * 1000
      : 0;

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
      this.chatLengthBeforeWarning < this.chatMessages.length
    ) {
      this.chatMessages = this.chatMessages.slice(
        0,
        this.chatLengthBeforeWarning,
      );
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

    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: DORMANT_CANCEL_PROMPT,
          },
        ],
      },
    });
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
   *
   * Bewusst als einzelne Items mit echten Rollen statt als ein Textblock:
   * Bei role "assistant" übernimmt das Modell diese Aussagen als seine eigenen
   * und macht nahtlos weiter. Derselbe Inhalt als Transkript-Text in einer
   * User-Nachricht wäre für das Modell nur ein Bericht ÜBER ein Gespräch –
   * es antwortet dann mit "laut dem Verlauf haben wir über X gesprochen".
   *
   * REIHENFOLGE IST KRITISCH: Erst der Verlauf, der Hinweistext ZULETZT.
   * Direkt danach folgt response.create, und das Modell antwortet immer auf
   * den jüngsten Turn. Stünde der Hinweis vorne, wäre die letzte Nachricht
   * eine alte Nutzer-Anweisung ("erzähl mir eine Kurzgeschichte") – die das
   * Modell dann prompt ein zweites Mal ausführt, statt sich zurückzumelden.
   */
  private injectConversationHistory(noticeText: string): void {
    const history = this.chatMessages.filter((m) => m.text.trim());

    // Rahmt den Verlauf als Erinnerung ein, damit alte Anweisungen darin
    // nicht als frische Aufträge gelesen werden.
    if (history.length > 0) {
      this.sendJson({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: HISTORY_PREAMBLE_PROMPT,
            },
          ],
        },
      });
    }

    let injected = 0;

    for (const msg of history) {

      this.sendJson(
        msg.role === "user"
          ? {
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: msg.text }],
              },
            }
          : {
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: msg.text }],
              },
            },
      );

      injected++;
    }

    // ZULETZT – siehe Reihenfolge-Hinweis oben. Das ist der Turn, auf den das
    // Modell beim folgenden response.create tatsächlich antwortet.
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: noticeText }],
      },
    });

    this.log(`${injected} Konversations-Items injiziert`);
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
  /**
   * Fordert bei der App ein neues Session-Token an (Event OnTokenNeeded) und wartet auf die
   * Property SessionProperties (JSON mit access_token und endpoint). Bei einem Fehler liefert die App
   * "error:<eindeutiger Zusatz>:<Meldung>", das Control bricht dann sofort mit dieser Meldung ab.
   * Die Wartezeit ist nur die Reserve für eine App, die das Event nicht beantwortet.
   */
  private requestSessionToken(): Promise<{
    accessToken: string;
    endpoint: string;
  }> {
    return new Promise((resolve, reject) => {
      const raiseTokenNeeded = this.events?.OnTokenNeeded;
      if (!raiseTokenNeeded) {
        reject(
          new Error(
            "Das Event OnTokenNeeded gibt es nur in Canvas-Apps und Custom Pages",
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.tokenWaiter = null;
        reject(
          new Error(
            "Die App hat kein Session-Token geliefert (ist OnTokenNeeded belegt?)",
          ),
        );
      }, TOKEN_WAIT_MS);

      this.tokenWaiter = (value: string) => {
        clearTimeout(timer);
        if (value.startsWith("error:")) {
          const message = value.split(":").slice(2).join(":").trim();
          reject(
            new Error(message || "Session-Token konnte nicht abgerufen werden"),
          );
          return;
        }

        let parsed: { access_token?: unknown; endpoint?: unknown } = {};
        try {
          parsed = JSON.parse(value);
        } catch {
          // fällt unten in die Fehlermeldung
        }
        const accessToken =
          typeof parsed.access_token === "string" ? parsed.access_token : "";
        const endpoint =
          typeof parsed.endpoint === "string" ? parsed.endpoint : "";
        if (!accessToken || !endpoint.startsWith("wss://")) {
          reject(
            new Error(
              "SessionProperties enthält kein gültiges JSON mit access_token und endpoint (wss://…)",
            ),
          );
          return;
        }
        resolve({ accessToken, endpoint });
      };

      raiseTokenNeeded();
    });
  }

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
      const { accessToken, endpoint } = await this.requestSessionToken();

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
          this.transcriptText = "";

          this.currentAiTranscript = "";

          this.currentUserTranscript = "";

          // Ein frischer Start begrüßt neu – eine evtl. noch gesetzte
          // Rückmeldung aus einer abgebrochenen Sitzung gilt nicht mehr.
          this.pendingResumeResponse = false;

          this.clearChat();
        }
        this.mcpFollowUpPending = false;
        // #endregion Session-Handling
        // #region Session-Payload


        // Voice-Agent-Endpunkt (kind: voice): Format der GA-Realtime-API mit
        // verschachteltem audio.input / audio.output statt flacher Felder.
        // Turn-Detection-Typ und Echo-Cancellation-Kanäle muss die Agent-Definition
        // schon tragen (azure_semantic_vad_multilingual, bei USE_LIVE_REFERENCE_AEC
        // Client-Referenz mit 2 Kanälen) – die Session kann sie nicht mehr ändern.
        const sessionPayload: Record<string, unknown> = {
          type: "realtime",
          // instructions NICHT setzen – wird vom Foundry Agent geladen.
          // Voice, VAD, Noise Suppression etc. sind Session-Properties und
          // müssen immer explizit konfiguriert werden (kommen NICHT vom Agent).
          output_modalities: ["text", "audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },

              turn_detection: {
                type: "azure_semantic_vad_multilingual",
                threshold: this.config.vadThreshold,
                prefix_padding_ms: 300,
                silence_duration_ms: this.config.silenceDurationMs,
                languages: [this.config.agentLanguage],
                remove_filler_words: false,
                interrupt_response: true,
                auto_truncate: false,
              },

              noise_reduction: {
                type: "azure_deep_noise_suppression",
              },

              // Live-Reference AEC: Der Client liefert das tatsächlich abgespielte
              // Signal als zweiten Kanal mit, statt dass der Server sein eigenes
              // gesendetes Audio als Referenz annimmt.
              //
              // Der Standardweg (reference_source "server") setzt voraus, dass der
              // Client sofort abspielt – bei mehr als zwei Sekunden Verzögerung
              // bricht die Entzerrung zusammen. Da die Wiedergabe hier auf einer
              // Zeitleiste geplant wird und der Dienst schneller als Echtzeit
              // streamt, ist genau das der Fall.
              echo_cancellation: {
                type: "server_echo_cancellation",
                ...(USE_LIVE_REFERENCE_AEC
                  ? { reference_source: "client", channels: 2 }
                  : {}),
              },

              transcription: {
                model: "azure-speech",
                language: this.config.agentLanguage,
              },
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: {
                type: "azure-standard",
                name: this.config.agentVoice,
                temperature: 0.8,
              },
              speed: Number(this.config.voiceSpeed) || 1,
            },
          },
        };
        // #endregion Session-Payload
        
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
          const greetingText = greetingPrompt(this.config.userName);
          this.sendJson({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: greetingText,
                },
              ],
            },
          });
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
        if (this.activeSources.length > 0) {
          for (const source of this.activeSources) {
            try {
              source.onended = null;

              source.stop();
            } catch (e) {
              /* ignore */
            }
          }

          this.activeSources = [];
        }

        // 2. Timeline für die nächste Response zurücksetzen
        if (this.audioContext) {
          this.nextPlayTime = this.audioContext.currentTime;
        }

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
        this.currentUserTranscript = "";
        this.lastUserBubbleEl = null;
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
        this.currentAiTranscript = "";
        this.lastAiBubbleEl = null;
        this.chatMessages.push({ role: "ai", text: "" });
        this.addChatBubble("ai", "\u2026");
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
          this.playAudioDelta(msg.delta);
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
        if (this.currentAiTranscript) {
          this.transcriptText += `[KI]: ${this.currentAiTranscript}\n`;
          const lastAi = this.chatMessages
            .slice()
            .reverse()
            .find((m: ChatMessage) => m.role === "ai");
          if (lastAi) lastAi.text = this.currentAiTranscript;
          this.updateLastAiBubble();
          this.currentAiTranscript = "";
          this.notifyOutputChanged();
        }

        this.lastAiBubbleEl = null;
        this.markConversationActivity();

        if (this.dormancyPhase === "warning") {
          // Die Ruhemodus-Ansage ist fertig formuliert. Bewusst KEIN
          // pendingListeningTransition – sonst würde das letzte onended erst
          // auf "listening" schalten (grüner Verbunden-Punkt) und dann trennen.
          if (this.activeSources.length > 0) {
            this.pendingDormantTransition = true;
            this.log(
              `Ruhemodus-Ansage: ${this.activeSources.length} Audio-Chunks laufen noch`,
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
          if (this.activeSources.length > 0) {
            this.pendingListeningTransition = true;
            this.log(`response.done: ${this.activeSources.length} Audio-Chunks noch im Playback – warte auf Ende`);
          } else {
            this.setState("listening");
          }
        }
        break;

      // ── Transkriptions-Events ────────────────────────────────────
      // Voice Live: Streaming User-Transkript (Wort für Wort)
      case "conversation.item.input_audio_transcription.delta":
        if (msg.delta) {
          this.currentUserTranscript += msg.delta;
          this.updateLastUserBubble();
        }
        break;

      // Finales User-Transkript (kompatibel mit Realtime API)
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) {
          this.currentUserTranscript = msg.transcript;
          this.transcriptText += `[User]: ${msg.transcript}\n`;
          // Wenn wir schon eine Streaming-Bubble haben, aktualisiere sie
          if (this.lastUserBubbleEl) {
            const lastUser = this.chatMessages
              .slice()
              .reverse()
              .find((m: ChatMessage) => m.role === "user");

            if (lastUser) lastUser.text = msg.transcript;

            this.lastUserBubbleEl.textContent = msg.transcript;
          } else {
            this.chatMessages.push({ role: "user", text: msg.transcript });

            this.addChatBubble("user", msg.transcript);
          }
          this.currentUserTranscript = "";
          this.lastUserBubbleEl = null;
          this.notifyOutputChanged();
        }
        break;

      // KI-Transkript (Streaming)
      case "response.output_audio_transcript.delta":
        if (msg.delta) {
          this.currentAiTranscript += msg.delta;
          const lastAiDelta = this.chatMessages
            .slice()
            .reverse()
            .find((m: ChatMessage) => m.role === "ai");
          if (lastAiDelta) lastAiDelta.text = this.currentAiTranscript;
          this.updateLastAiBubble();
        }

        break;

      case "response.output_audio_transcript.done":
        if (msg.transcript) {
          this.currentAiTranscript = msg.transcript;
          const lastAiDone = this.chatMessages
            .slice()
            .reverse()
            .find((m: ChatMessage) => m.role === "ai");
          if (lastAiDone) lastAiDone.text = msg.transcript;
          this.updateLastAiBubble();
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

  // #region Audio-Pipeline (Mikrofon, Wiedergabe, Visualisierung)

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
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      this.audioContext = new Ctx();

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

      this.log("AudioContext angelegt, Worklet registriert, Wiedergabe-Bus verbunden");
    }

    // Bewusst ohne Zustandsprüfung: cleanupConnection() suspendiert ohne zu
    // warten. Verbindet man schnell wieder, steht state noch auf "running",
    // während suspend() gerade läuft – eine Prüfung würde das resume
    // überspringen und der Context bliebe stumm zurück. Auf einem laufenden
    // Context ist resume() ein No-op.
    await this.audioContext.resume();

    return this.audioContext;
  }

  /**
   * Mikrofon-Aufnahme starten und Audio-Pipeline aufbauen.
   *
   * Pipeline:
   *   Mikrofon → MediaStreamSource → AudioWorklet → Resample → PCM16 → Base64 → WebSocket
   *                                 ↘ Analyser → Visualisierung (Orb + VU-Meter)
   *
   * Kein manueller Noise Gate – Voice Live macht serverseitige Noise Suppression.
   */
  private async startMicrophone(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const errMsg =
          "getUserMedia nicht verf\u00fcgbar \u2013 HTTPS oder Browser-Support pr\u00fcfen";

        this.log(`FEHLER (Mikrofon): ${errMsg}`);
        this.setState("error", errMsg);
        return;
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

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.micSource.connect(this.analyser);

      // Zwei Eingänge: Mikrofon und Echo-Referenz. Der Wiedergabe-Bus liegt
      // parallel auf den Lautsprechern und auf Eingang 1 – so bekommt der
      // Server genau das Signal als Referenz, das der Benutzer wirklich hört.
      this.audioWorklet = new AudioWorkletNode(ctx, "processor", {
        numberOfInputs: 2,
      });
      this.micSource.connect(this.audioWorklet, 0, 0);
      this.playbackBus?.connect(this.audioWorklet, 0, 1);

      // Daten vom Worklet empfangen und an WebSocket senden
      this.audioWorklet.port.onmessage = (e: MessageEvent) => {
        // isProtectedResponse hält die Ruhemodus-Ansage unterbrechungsfest:
        // Ohne Upstream-Audio erkennt das server-seitige VAD keine Sprache,
        // also kann weder der Server noch der Client die Ansage abbrechen.
        if (
          this.ws?.readyState !== WebSocket.OPEN ||
          this.isMuted ||
          this.isProtectedResponse
        )
          return;

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
        const base64 = bufferToBase64(pcm16.buffer as ArrayBuffer);

        this.sendJson({ type: "input_audio_buffer.append", audio: base64 });
      };

      this.log("AudioWorklet gestartet, Mikrofonaufnahme läuft");

      this.startVisualization();
    } catch (err: unknown) {
      const name = err instanceof DOMException ? err.name : "";

      const messages: Record<string, string> = {
        NotAllowedError:
          "Mikrofonberechtigung verweigert \u2013 bitte in den App-Einstellungen erlauben",

        PermissionDeniedError:
          "Mikrofonberechtigung verweigert \u2013 bitte in den App-Einstellungen erlauben",

        NotFoundError: "Kein Mikrofon gefunden",

        NotReadableError: "Mikrofon wird von einer anderen App verwendet",

        NotSupportedError:
          "Mikrofon-API nicht unterst\u00fctzt (HTTPS erforderlich)",

        SecurityError:
          "Sicherheitseinschr\u00e4nkung \u2013 Seite muss \u00fcber HTTPS geladen sein",
      };

      const finalMsg =
        messages[name] ?? `Mikrofonfehler: ${name || String(err)}`;

      this.log(`FEHLER (Mikrofon): ${finalMsg}`);

      this.setState("error", finalMsg);
    }
  }

  /** Treibt Orb-Skalierung und VU-Meter aus der Lautstärke (RMS) des Mikrofonsignals. */
  private startVisualization(): void {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const barCount = this.vuBars.length;

    const tick = () => {
      // analyser wird beim Trennen genullt – ohne Prüfung würde eine bereits
      // eingeplante Frame-Ausführung hier krachen.
      if (!this.analyser) {
        this.animationFrameId = null;
        return;
      }

      this.animationFrameId = requestAnimationFrame(tick);
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;

      // Nur tatsächliche Lautstärke berechnen, wenn nicht gemuted
      if (!this.isMuted) {
        for (const v of dataArray) sum += v ** 2;
      }

      const rms = Math.sqrt(sum / dataArray.length) / 255;
      const level = Math.min(rms * 3.5, 1);

      if (this.controlState === "user-speaking" && this.orbEl) {
        this.orbEl.style.transform = `scale(${(1 + level * 0.35).toFixed(3)})`;
      }

      for (let i = 0; i < barCount; i++) {
        const idx = Math.floor((i / barCount) * dataArray.length * 0.45);

        // VU-Bars bei Mute fest auf 3px (Minimalhöhe) zwingen
        const h = Math.max(3, this.isMuted ? 3 : (dataArray[idx] / 255) * 26);
        this.vuBars[i].style.height = `${h}px`;
      }
    };

    tick();
  }

  /** Dekodiert einen Base64/PCM16-Audio-Chunk und plant ihn lückenlos auf der Wiedergabe-Zeitleiste ein. */
  private playAudioDelta(base64: string): void {
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

      // Letzter Chunk fertig abgespielt → jetzt auf 'listening' wechseln
      if (this.activeSources.length === 0 && this.pendingListeningTransition) {
        this.pendingListeningTransition = false;
        if (this.controlState === "ai-speaking") {
          this.setState("listening");
        }
      }

      // Ruhemodus-Ansage ist verklungen → Nachlaufzeit starten
      if (this.activeSources.length === 0 && this.pendingDormantTransition) {
        this.pendingDormantTransition = false;
        if (this.dormancyPhase === "warning") {
          this.armDormantDelay();
        }
      }
    };

    this.activeSources.push(source);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // #endregion

  // #region Event-Log

  // ══════════════════════════════════════════════════════════════════════
  //  EVENT-LOG
  // ══════════════════════════════════════════════════════════════════════

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    this.eventLogText += entry + "\n";
    this.eventLogEntries.push(entry);
    console.log("[VoiceLive]", msg);

    if (this.eventLogEl) {
      const line = document.createElement("div");

      line.className = "ai-event-log-line";

      if (
        msg.includes("FEHLER") ||
        msg.includes("error") ||
        msg.includes("Error")
      ) {
        line.classList.add("ai-event-log-error");
      } else if (msg.includes("WARNUNG") || msg.includes("warning")) {
        line.classList.add("ai-event-log-warn");
      }

      line.textContent = entry;

      this.eventLogEl.appendChild(line);

      this.eventLogEl.scrollTop = this.eventLogEl.scrollHeight;
    }
  }

  // #endregion

  // #region Chat-Panel

  // ══════════════════════════════════════════════════════════════════════
  //  CHAT-PANEL – WhatsApp-Style Transkript-Anzeige
  // ══════════════════════════════════════════════════════════════════════

  private toggleChat(): void {
    this.chatOpen = !this.chatOpen;
    this.container.classList.toggle("chat-open", this.chatOpen);

    if (this.chatOpen) {
      // Beim Öffnen immer ans Ende, auch wenn zuvor hochgescrollt war.
      this.chatAutoScroll = true;

      // Erst im nächsten Frame: Das Panel wechselt gerade von display:none auf
      // flex, und der Orb-Bereich schrumpft per Transition – im selben Tick
      // stünde noch die alte Geometrie zur Verfügung.
      requestAnimationFrame(() => this.scrollToBottom(true));
    }
  }

  private addChatBubble(role: "user" | "ai", text: string): void {
    const emptyEl = this.chatMessagesEl.querySelector(".ai-chat-empty");

    if (emptyEl) emptyEl.remove();

    const bubble = document.createElement("div");
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    bubble.textContent = text;

    if (
      role === "user" &&
      this.lastAiBubbleEl?.parentElement === this.chatMessagesEl
    ) {
      this.chatMessagesEl.insertBefore(bubble, this.lastAiBubbleEl);
    } else {
      this.chatMessagesEl.appendChild(bubble);
    }

    if (role === "ai") {
      this.lastAiBubbleEl = bubble;
    } else {
      this.lastUserBubbleEl = bubble;
    }

    this.scrollToBottom();
  }

  private updateLastAiBubble(): void {
    if (!this.lastAiBubbleEl) return;

    this.lastAiBubbleEl.textContent = this.currentAiTranscript;

    this.scrollToBottom();
  }

  /** Aktualisiert die letzte User-Bubble mit dem laufenden Streaming-Transkript. */
  private updateLastUserBubble(): void {
    if (!this.lastUserBubbleEl) {
      // Erste Delta – neue Bubble erstellen

      this.chatMessages.push({
        role: "user",
        text: this.currentUserTranscript,
      });

      this.addChatBubble("user", this.currentUserTranscript);

      return;
    }

    this.lastUserBubbleEl.textContent = this.currentUserTranscript;

    this.scrollToBottom();
  }

  /**
   * Scrollt den Chat ans Ende, solange der Nutzer mitliest.
   *
   * @param force Auch scrollen, wenn der Nutzer hochgescrollt hat
   *              (beim Öffnen des Chats gewollt).
   */
  private scrollToBottom(force = false): void {
    const el = this.chatPanel;

    if (!el) return;
    if (!force && !this.chatAutoScroll) return;

    // Eine Zuweisung an scrollTop feuert selbst ein scroll-Event. Ohne diese
    // Markierung würde onChatScroll() den eigenen Scroll für eine Nutzergeste
    // halten und das Mitscrollen sofort wieder abschalten.
    this.isProgrammaticScroll = true;
    el.scrollTop = el.scrollHeight;

    requestAnimationFrame(() => {
      this.isProgrammaticScroll = false;
    });
  }

  /** Merkt sich, ob der Nutzer weggescrollt hat oder wieder mitliest. */
  private onChatScroll(): void {
    if (this.isProgrammaticScroll) return;

    const el = this.chatPanel;

    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    this.chatAutoScroll =
      distanceFromBottom <= VoiceLiveControl.CHAT_BOTTOM_THRESHOLD_PX;
  }

  private clearChat(): void {
    this.chatMessages = [];
    this.lastAiBubbleEl = null;
    this.lastUserBubbleEl = null;
    this.chatAutoScroll = true;

    if (this.chatMessagesEl) {
      this.chatMessagesEl.innerHTML =
        '<p class="ai-chat-empty">Gespräch starten, um Transkript zu sehen</p>';
    }
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

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);

      this.animationFrameId = null;
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }

    // Der AudioContext überlebt einzelne Verbindungen (siehe
    // ensureAudioContext), also muss der Sitzungs-Graph hier von Hand abgebaut
    // werden. Früher hat close() das miterledigt – bleiben die Knoten stehen,
    // sammeln sich Quellknoten auf beendeten MediaStreams an und der neue
    // Mikrofonpfad liefert keine Daten mehr.
    //
    // Reihenfolge ist wichtig: erst die Knoten trennen, dann die Tracks
    // stoppen. Andersherum steht kurzzeitig ein Quellknoten auf einem
    // beendeten Stream im Graph – genau der Zustand, der das Problem auslöst.
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

    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    // Bewusst kein suspend(): Das schließt den Ausgabepfad, und beim Öffnen
    // entscheidet Android neu, ob die Wiedergabe auf dem Musik- oder dem
    // Anruf-Stream landet. Der Context läuft durch, sein Graph ist jetzt leer
    // und rendert Stille.

    if (this.orbEl) this.orbEl.style.transform = "";

    this.vuBars.forEach((b) => {
      b.style.height = "3px";
    });

    this.activeSources.forEach((s) => {
      try {
        // onended zuerst lösen: stop() feuert es asynchron, das Array ist dann
        // längst leer – der Handler würde eine Transition scharfschalten,
        // obwohl die Verbindung gerade abgebaut wird.
        s.onended = null;
        s.stop();
      } catch {
        /* */
      }
    });

    this.activeSources = [];
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
      Transcript: this.transcriptText,
      EventLog: this.eventLogText,
    };
  }

  public destroy(): void {
    this.cleanup();

    // Der AudioContext überlebt bewusst einzelne Verbindungen (siehe
    // ensureAudioContext). Beim Zerstören des Controls muss er aber wirklich
    // geschlossen werden, sonst stapeln sich in einer Canvas App bei jedem
    // Screen-Wechsel neue Contexts, bis der Browser keinen weiteren zulässt.
    //
    // Bewusst hier und NICHT in cleanup(): Das ruft auch stopSession() auf,
    // dort würde ein close() die Wiederverwendung wieder zunichtemachen.
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
