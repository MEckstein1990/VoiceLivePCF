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
  ServerEvent,
  SessionStartMode,
} from "./types";
import {
  ControlConfig,
  INITIAL_CONFIG,
  MAX_RECONNECT_ATTEMPTS,
  USE_LIVE_REFERENCE_AEC,
  readConfig,
} from "./config";
import {
  DORMANT_RESUME_PROMPT,
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
import { DormancyController } from "./dormancy/DormancyController";
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
  private audio: AudioEngine = new AudioEngine({
    log: (msg) => this.log(msg),
    // Ruhemodus-Ansage: siehe isProtectedResponse
    canSend: () =>
      this.ws?.readyState === WebSocket.OPEN &&
      !this.isMuted &&
      !this.dormancy.isProtectedResponse,
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

  // #region Ruhemodus (siehe dormancy/DormancyController.ts)
  private dormancy: DormancyController = new DormancyController({
    log: (msg) => this.log(msg),
    config: () => this.config,
    canAnnounce: () =>
      this.controlState === "listening" &&
      this.ws?.readyState === WebSocket.OPEN &&
      !this.isCancelling,
    conversationLength: () => this.conversation.length,
    remainingPlaybackMs: () => this.audio.remainingPlaybackMs,
    sendJson: (obj) => this.sendJson(obj),
    setListening: () => this.setState("listening"),
    showStatusText: (text) => {
      if (this.statusTextEl) this.statusTextEl.textContent = text;
    },
    setPendingClass: (on) => {
      if (on) {
        this.container.classList.add("dormant-pending");
      } else {
        this.container.classList.remove("dormant-pending");
      }
    },
    enterDormant: () => this.enterDormantMode(),
  });
  /** Löst nach dem Wiederverbinden eine kurze Rückmeldung der KI aus. */
  private pendingResumeResponse = false;

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
      this.dormancy.onPointerDown(e.target as Element | null),
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
      this.dormancy.abort();
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
      dormancyPhase: this.dormancy.phase,
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

  // #region Ruhemodus: Trennen und Aufwecken (Ablauf: dormancy/DormancyController.ts)

  /** Trennt die Verbindung, behält aber den Gesprächskontext. */
  private enterDormantMode(): void {
    if (this.controlState === "idle" || this.controlState === "dormant") return;

    this.log("Ruhemodus aktiv – Verbindung getrennt, Mikrofon aus");

    // Die Abschiedsansage aus dem Kontext nehmen, bevor cleanupConnection()
    // über dormancy.abort() den Merker verwirft. Die Chat-Blase bleibt sichtbar,
    // sie wird beim Aufwecken nur nicht als Gesprächsverlauf zurückgespielt.
    const lengthBeforeWarning = this.dormancy.lengthBeforeWarning;
    if (
      lengthBeforeWarning !== null &&
      lengthBeforeWarning < this.conversation.length
    ) {
      this.conversation.truncate(lengthBeforeWarning);
    }

    // Verhindert, dass onclose einen Auto-Reconnect auslöst.
    this.intentionalClose = true;
    this.reconnectAttempt = 0;

    // cleanupConnection() ruft dormancy.abort() – deshalb erst danach die
    // Phase auf "dormant" setzen, sonst wird sie sofort wieder überschrieben.
    this.cleanupConnection();

    this.dormancy.markDormant();
    this.setState("dormant");
  }

  /** Weckt eine schlafende Session wieder auf – mit Gesprächskontext. */
  private wakeFromDormant(): void {
    this.log("Ruhemodus wird beendet – Session wird fortgesetzt");

    this.reconnectAttempt = 0;

    // Phase verlassen und die Frist neu starten – sonst würde der erste Tick
    // die frisch geweckte Session sofort wieder schlafen legen.
    this.dormancy.prepareWake();

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
          this.dormancy.resetIdleTimer();
        }

        this.dormancy.markConversationActivity();

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
        this.dormancy.startIdleWatch();
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
        if (this.dormancy.isProtectedResponse) {
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
        this.dormancy.markConversationActivity();
        // Während der Ruhemodus-Ansage nicht auf "listening" zurückfallen –
        // das würde den Countdown-Text überschreiben.
        if (!this.dormancy.isProtectedResponse) {
          this.setState("listening");
        }
        break;

      case "response.created":
        this.dormancy.markConversationActivity();
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
          this.dormancy.noteToolActivity();
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
        this.dormancy.noteToolActivity();
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

        this.dormancy.markConversationActivity();

        // Ist das die Ruhemodus-Ansage, übernimmt der Ruhemodus das Ende der Antwort.
        if (this.dormancy.onResponseDone(this.audio.activeCount)) {
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
        this.dormancy.abort();

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
    this.dormancy.onPlaybackDrained();
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

    // Vollständiger Ausstieg – auch aus dem Ruhemodus heraus (siehe
    // DormancyController.reset()).
    this.dormancy.reset();
    this.pendingResumeResponse = false;

    this.setState("idle");
  }

  /** Räumt nur WS + Audio auf, behält Chat/Transkript für Reconnect. */
  private cleanupConnection(): void {
    // Zentraler Aufräumpunkt für alle Ruhemodus-Timer: deckt Verbindungsabbruch,
    // manuelles Trennen und destroy() in einem Zug ab. Ohne das würde ein
    // laufendes Intervall nach der Zerstörung notifyOutputChanged() aufrufen.
    this.dormancy.stopIdleWatch();

    this.dormancy.abort();

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
