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
 */

import { IInputs, IOutputs } from "./generated/ManifestTypes";
// import * as msal from "@azure/msal-browser"; // MSAL deaktiviert – caller-id wird über PCF userId übergeben

/**
 * Zustandsmodell des Controls – steuert UI-Darstellung und erlaubte Aktionen.
 *
 *   idle ──▶ connecting ──▶ listening ◀──▶ user-speaking
 *                         ▲      ▲                 │
 *                         │      └── ai-speaking◀─┘
 *                         │               │
 *                    Reconnecting◀───── error
 */

type ControlState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "user-speaking"
  | "ai-thinking"
  | "ai-speaking"
  | "error";
/** Typisierung für eingehende WebSocket-Nachrichten von Voice Live API. */

interface ServerEvent {
  type: string;
  /** Base64-kodierter Audio-Chunk (nur bei `response.audio.delta`). */
  delta?: string;
  /** Transkript-Text (bei Transkriptions-Events). */
  transcript?: string;
  error?: { message: string };
  warning?: { message: string };
  /** MCP-Tool-Aufruf Item (bei response.output_item.added mit type=mcp_call). */
  item?: {
    type?: string;
    name?: string;
    server_label?: string;
  };
  /** Finale Tool-Argumente als JSON-String (bei response.mcp_call_arguments.done). */
  arguments?: string;
}

/** Einzelne Chat-Nachricht für die visuelle Darstellung im Chat-Panel. */

interface ChatMessage {
  role: "user" | "ai";
  text: string;
}

export class VoiceLiveControl implements ComponentFramework.StandardControl<
  IInputs,
  IOutputs
> {
  // ── Infrastruktur ────────────────────────────────────────────────────
  private container!: HTMLDivElement;
  private notifyOutputChanged!: () => void;
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
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

  // ── Reconnect ────────────────────────────────────────────────────────
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_BASE_DELAY_MS = 1500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Transkript ───────────────────────────────────────────────────────
  private transcriptText = "";
  private eventLogText = "";
  private currentAiTranscript = "";
  private currentUserTranscript = "";

  // ── Chat-UI ──────────────────────────────────────────────────────────
  private chatMessages: ChatMessage[] = [];
  private chatOpen = false;
  // ── Event-Log (Debug) ────────────────────────────────────────────────
  private eventLogEntries: string[] = [];
  // private eventLogOpen = true;
  private eventLogEl!: HTMLDivElement;
  // private eventLogToggleBtn!: HTMLButtonElement;
  private loggedInit = false;

  // ── Konfiguration (aus Power Apps Properties) ────────────────────────
  private agentId = "";
  private agentProjectName = "";
  private agentendpoint = "";
  private tokenEndpoint = "";
  private proxyKey = "";
  private agentVoice = "de-DE-Florian:DragonHDLatestNeural";
  private silenceDurationMs = 2000;
  private vadThreshold = 0.5;
  private agentLanguage = "de";
  private voiceSpeed = "1.0";
  private userName = "";

  /** Dynamisch vom Backend geholter Token – wird nach Session-Ende verworfen. */
  // private fetchedToken = '';

  // ── MSAL / Dataverse User-Token (deaktiviert) ─────────────────────────
  private msalClientId = "";
  private tenantId = "";
  private dataverseOrgUrl = "";
  private callerId = "";
  // private msalInstance: msal.PublicClientApplication | null = null;
  // private dataverseUserToken = "";

  // ── Agent-Defaults (werden durch Power Apps Properties überschrieben) ─────
  private static readonly DEFAULT_AGENT_ENDPOINT =
    "https://foundry-enbw-KoRa-AI-sc.services.ai.azure.com"; //'https://test-speechlive-mcp.services.ai.azure.com';
  private static readonly DEFAULT_AGENT_ID = "dataverse-proxy-agent"; // 'dataverse-proxy-agent-v3';
  private static readonly DEFAULT_AGENT_PROJECT = "proj-default";
  private static readonly DEFAULT_TOKEN_ENDPOINT =
    "https://func-voicelive-kora.azurewebsites.net"; //'https://voicelivesessionapi-fgc4ebcfcnc3awef.germanywestcentral-01.azurewebsites.net';
  private static readonly DEFAULT_PROXY_KEY =
    "qXKfGt8HOB9gNVQncysd1MAjYvo2bCz64wTIiZUlRLxrE057";
  private static readonly DEFAULT_AGENT_VOICE =
    "de-DE-Florian:DragonHDLatestNeural";
  private static readonly DEFAULT_AGENT_LANGUAGE = "de";
  private static readonly DEFAULT_SILENCE_DURATION = 2000;
  private static readonly DEFAULT_VAD_THRESHOLD = 0.5;
  private static readonly DEFAULT_VOICE_SPEED = "1.0";
  private static readonly DEFAULT_USER_NAME = "";

  /** Benutzerfreundliche Anzeigenamen für Dataverse-Tabellen */
  private static readonly TABLE_DISPLAY_NAMES: Record<string, string> = {
    account: "Kunden",
    contact: "Kontakte",
    netzebw_kora_minutes: "Protokolle",
    opportunity: "Verkaufschancen",
    incident: "Anfragen",
    task: "Aufgaben",
    appointment: "Termine",
  };

  // ── DOM-Referenzen ───────────────────────────────────────────────────
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
                <p class="ai-voice-status-text">Inaktiv</p>
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

    // this.eventLogEl = this.container.querySelector('.ai-event-log-body') as HTMLDivElement;

    // this.eventLogToggleBtn = this.container.querySelector('.ai-event-log-toggle') as HTMLButtonElement;

    // const eventLogClearBtn = this.container.querySelector('.ai-event-log-clear') as HTMLButtonElement;

    this.chatToggleBtn.addEventListener("click", () => this.toggleChat());

    // this.eventLogToggleBtn.addEventListener('click', () => {
    //     this.eventLogOpen = !this.eventLogOpen;
    //     this.eventLogEl.style.display = this.eventLogOpen ? 'block' : 'none';
    //     this.eventLogToggleBtn.textContent = this.eventLogOpen ? '\u25BC' : '\u25B6';
    // });
    // eventLogClearBtn.addEventListener('click', () => {
    //     this.eventLogEntries = [];
    //     this.eventLogEl.innerHTML = '';
    // });

    this.muteBtn.addEventListener("click", () => this.toggleMute());
    this.connectBtn.addEventListener("click", () => this.toggleConnection());
    this.container.className = "ai-voice-container state-idle";
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    // PCF-Testharnisch liefert "val" als Platzhalter für alle Properties –
    // in diesem Fall greifen die eingebauten Defaults.
    const prop = (raw: string | null | undefined, def: string): string =>
      raw && raw !== "val" && raw !== "undefined" ? raw : def;
    this.agentId = prop(
      context.parameters.AgentId.raw,
      VoiceLiveControl.DEFAULT_AGENT_ID,
    );
    this.agentProjectName = prop(
      context.parameters.AgentProjectName.raw,
      VoiceLiveControl.DEFAULT_AGENT_PROJECT,
    );
    this.tokenEndpoint = prop(
      context.parameters.TokenEndpoint.raw,
      VoiceLiveControl.DEFAULT_TOKEN_ENDPOINT,
    );
    this.proxyKey = prop(
      context.parameters.ProxyKey.raw,
      VoiceLiveControl.DEFAULT_PROXY_KEY,
    );
    this.agentendpoint = prop(
      context.parameters.AgentEndpoint.raw,
      VoiceLiveControl.DEFAULT_AGENT_ENDPOINT,
    );
    this.agentVoice = prop(
      context.parameters.AgentVoice.raw,
      VoiceLiveControl.DEFAULT_AGENT_VOICE,
    );
    this.agentLanguage = prop(
      context.parameters.AgentLanguage.raw,
      VoiceLiveControl.DEFAULT_AGENT_LANGUAGE,
    );
    this.voiceSpeed = prop(
      context.parameters.VoiceSpeed.raw,
      VoiceLiveControl.DEFAULT_VOICE_SPEED,
    );
    this.msalClientId = (context.parameters.MsalClientId.raw ?? "").trim();
    this.tenantId = (context.parameters.TenantId.raw ?? "").trim();
    this.dataverseOrgUrl = (context.parameters.DataverseOrgUrl.raw ?? "")
      .replace(/\/$/, "")
      .trim();
    this.silenceDurationMs =
      typeof context.parameters.SilenceDurationMs.raw === "number"
        ? context.parameters.SilenceDurationMs.raw
        : VoiceLiveControl.DEFAULT_SILENCE_DURATION;
    this.vadThreshold =
      typeof context.parameters.VadThreshold.raw === "number"
        ? context.parameters.VadThreshold.raw
        : VoiceLiveControl.DEFAULT_VAD_THRESHOLD;
    // Canvas Apps: context.userSettings.userId ist nicht verfügbar (nur Model-Driven Apps).
    // Die User-GUID wird als PCF-Input-Property "UserId" übergeben.
    // Canvas App Formel: LookUp(SystemUsers, 'Azure AD Object ID' = User().ObjectId, SystemUserId)
    this.callerId = (context.parameters.UserId?.raw as string | null | undefined) ?? "";
    this.userName = prop(
      context.parameters.UserName.raw,
      VoiceLiveControl.DEFAULT_USER_NAME,
    );


    if (!this.loggedInit) {
      this.loggedInit = true;
      this.log(`Init: agentId=${this.agentId}, endpoint=${this.agentendpoint}`);
    }

    const configured = !!(
      this.agentId &&
      this.agentProjectName &&
      this.tokenEndpoint &&
      this.proxyKey &&
      this.agentendpoint
    );

    if (this.connectBtn) {
      this.connectBtn.disabled = !configured;

      if (!configured) this.connectBtn.title = "Konfiguration unvollständig";
    }

    const isActive = context.parameters.Connected.raw === true;

    if (isActive !== this.previousIsActive) {
      this.previousIsActive = isActive;

      this.log(
        `Connected=${isActive}, configured=${configured}, state=${this.controlState}`,
      );

      if (isActive && configured && this.controlState === "idle") {
        void this.startSession();
      } else if (isActive && !configured) {
        this.log("FEHLER: Nicht konfiguriert – kein Token/Endpoint vorhanden");
      } else if (
        !isActive &&
        this.controlState !== "idle" &&
        this.controlState !== "reconnecting"
      ) {
        this.stopSession();
      }
    }
  }

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

    this.container.className = classes.join(" ");

    const labels: Record<ControlState, { text: string; header: string }> = {
      idle: { text: "Inaktiv", header: "Nicht verbunden" },

      connecting: { text: "Verbinde\u2026", header: "Verbinde\u2026" },

      reconnecting: {
        text: `Verbindung wiederherstellen (${this.reconnectAttempt}/${VoiceLiveControl.MAX_RECONNECT_ATTEMPTS})\u2026`,
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
      this.connectBtn.title = isActive
        ? "Verbindung trennen"
        : "Verbindung herstellen";
    }

    if (this.orbEl) this.orbEl.style.transform = "";

    this.notifyOutputChanged();
  }

  /** Erzeugt benutzerfreundlichen Status-Text für einen MCP-Tool-Aufruf */
  private getToolDisplayText(toolName: string, args?: string): string {
    try {
      const parsed = args ? JSON.parse(args) : null;

      if (toolName === "read_query" && parsed?.querytext) {
        const match = parsed.querytext.match(/FROM\s+(\w+)/i);
        const table = match?.[1];
        const displayName = table
          ? VoiceLiveControl.TABLE_DISPLAY_NAMES[table] || table
          : "Daten";
        return `Durchsuche ${displayName}\u2026`;
      }

      if (toolName === "create_record" && parsed?.tablename) {
        const displayName =
          VoiceLiveControl.TABLE_DISPLAY_NAMES[parsed.tablename] || parsed.tablename;
        return `Speichere ${displayName}\u2026`;
      }

      if (toolName === "update_record") {
        return "Aktualisiere Daten\u2026";
      }

      if (toolName === "delete_record") {
        return "L\u00f6sche Eintrag\u2026";
      }
    } catch {
      // JSON-Parse fehlgeschlagen – Fallback
    }

    if (toolName.startsWith("read") || toolName.startsWith("search") || toolName.startsWith("list")) {
      return "Durchsuche Daten\u2026";
    }
    if (toolName.startsWith("create") || toolName.startsWith("save") || toolName.startsWith("write")) {
      return "Speichere Daten\u2026";
    }
    return "Verarbeite Anfrage\u2026";
  }

  /** Setzt den Status-Text f\u00fcr einen aktiven Tool-Aufruf (ohne State-Wechsel) */
  private setToolStatus(toolName: string, args?: string): void {
    const text = this.getToolDisplayText(toolName, args);
    if (this.statusTextEl && (this.controlState === "ai-thinking" || this.controlState === "ai-speaking")) {
      this.statusTextEl.textContent = text;
    }
    this.log(`Tool-Status: ${text}`);
  }

  /**
     * Startet eine neue Voice Live Session:
     *   1. Baut WebSocket-Verbindung zur Voice Live API auf
     *   2. Konfiguriert die Session (Semantic VAD, Noise Suppression, Echo Cancellation, Azure STT)
     *   3. Startet das Mikrofon
     *
     * Die URL wird aus dem Endpoint zusammengebaut:
     *   Agent-Modus:  wss://{proxyHost}/api/voice-live/ws?key=...&agent-id=...&agent-project-name=...  (WebSocket-Proxy)
     *   Direct-Modus: wss://{host}/voice-live/realtime?api-version=...&model=...&api-key=|access_token=...
     */
  /** Holt einen frischen Agent-Access-Token vom Backend-Endpoint. */

  private async fetchAgentToken(): Promise<string> {
    const url = `${this.tokenEndpoint.replace(/\/$/, "")}/api/voice-live/token`;
    const headers: Record<string, string> = {};
    if (this.proxyKey) headers["X-Proxy-Key"] = this.proxyKey;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Token-Endpoint Fehler ${resp.status}`);
    const data = (await resp.json()) as { token: string };
    if (!data.token)
      throw new Error("Token-Endpoint hat kein token-Feld zurückgegeben");
    return data.token;
  }

  // ── acquireDataverseToken deaktiviert (MSAL nicht benötigt) ────────────
  // private async acquireDataverseToken(): Promise<void> {
  //   if (!this.msalClientId || !this.tenantId || !this.dataverseOrgUrl) return;
  //   if (!this.msalInstance) {
  //     this.msalInstance = new msal.PublicClientApplication({ ... });
  //     await this.msalInstance.initialize();
  //   }
  //   const scopes = [`${this.dataverseOrgUrl}/.default`];
  //   try {
  //     const result = await this.msalInstance.ssoSilent({ scopes });
  //     this.dataverseUserToken = result.accessToken;
  //   } catch {
  //     const result = await this.msalInstance.acquireTokenPopup({ scopes });
  //     this.dataverseUserToken = result.accessToken;
  //   }
  // }

  private async startSession(isReconnect = false): Promise<void> {
    if (
      !this.agentId ||
      !this.agentProjectName ||
      !this.tokenEndpoint ||
      !this.proxyKey ||
      !this.agentendpoint
    )
      return;

    this.intentionalClose = false;

    if (!isReconnect) {
      this.reconnectAttempt = 0;
    }

    this.setState(isReconnect ? "reconnecting" : "connecting");

    try {
      // Dataverse User-Token per MSAL deaktiviert – caller-id wird via PCF userId übergeben
      // if (this.msalClientId && this.tenantId && this.dataverseOrgUrl) {
      //   await this.acquireDataverseToken();
      // }

      // Proxy-Modus: WebSocket-Proxy in der Function App übernimmt die Auth

      const proxyHost = this.tokenEndpoint
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");

      const wsUrl =
        `wss://${proxyHost}/api/voice-live/ws` +
        `?key=${encodeURIComponent(this.proxyKey)}` +
        `&agent-name=${encodeURIComponent(this.agentId)}` +
        `&agent-project-name=${encodeURIComponent(this.agentProjectName)}` +
        `&endpoint=${encodeURIComponent(this.agentendpoint)}` + 
        `&caller-id=${encodeURIComponent(this.callerId)}`;

      this.log(`WebSocket öffnet: wss://${proxyHost}/api/voice-live/ws`);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.log(
          isReconnect
            ? `WebSocket reconnected (Versuch ${this.reconnectAttempt})`
            : "WebSocket geöffnet, sende session.update...",
        );

        this.reconnectAttempt = 0;

        // Auth-Message mit Dataverse User-Token deaktiviert (MSAL nicht verwendet)
        // if (this.dataverseUserToken) {
        //   this.sendJson({ type: "auth", token: this.dataverseUserToken });
        // }

        if (!isReconnect) {
          this.transcriptText = "";

          this.currentAiTranscript = "";

          this.currentUserTranscript = "";

          this.clearChat();
        }

        const sessionPayload: Record<string, unknown> = {
          // instructions NICHT setzen – wird vom Foundry Agent geladen.
          // Voice, VAD, Noise Suppression etc. sind Session-Properties und
          // müssen immer explizit konfiguriert werden (kommen NICHT vom Agent).
          modalities: ["text", "audio"],
          voice: {
            type: "azure-standard",
            name: this.agentVoice,
            temperature: 0.8,
            rate: this.voiceSpeed,
          },

          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_sampling_rate: 24000,

          turn_detection: {
            type: "azure_semantic_vad_multilingual",
            threshold: this.vadThreshold,
            prefix_padding_ms: 300,
            silence_duration_ms: this.silenceDurationMs,
            languages: [this.agentLanguage],
            remove_filler_words: false,
            interrupt_response: true,
            auto_truncate: false,
          },

          input_audio_noise_reduction: {
            type: "azure_deep_noise_suppression",
          },

          input_audio_echo_cancellation: {
            type: "server_echo_cancellation",
          },

          input_audio_transcription: {
            model: "azure-speech",
            language: this.agentLanguage,
          },
        };

        // session.update MUSS als allererste Nachricht kommen –
        // der Server erwartet es als Session-Konfiguration.
        this.sendJson({ type: "session.update", session: sessionPayload });
        this.log("session.update gesendet");

        

        // Bei Reconnect: bisherigen Gesprächsverlauf als Konversations-Items injizieren
        // (NACH session.update – sonst "max_config_attempts_exceeded")
        if (isReconnect && this.chatMessages.length > 0) {
          // System-Hinweis als erste Nachricht
          this.sendJson({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    "[SYSTEM-HINWEIS] Die Verbindung wurde kurz unterbrochen und automatisch wiederhergestellt. " +
                    "Das Gespräch wird nahtlos fortgesetzt. Begrüße den Benutzer NICHT erneut – " +
                    "sage stattdessen kurz, dass du wieder da bist und wo ihr stehengeblieben seid.",
                },
              ],
            },
          });

          // Bisherige Chat-Nachrichten als Konversations-History einspielen
          for (const msg of this.chatMessages) {
            if (!msg.text.trim()) continue;

            if (msg.role === "user") {
              this.sendJson({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: msg.text }],
                },
              });
            } else {
              this.sendJson({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: msg.text }],
                },
              });
            }
          }

          this.log(
            `Reconnect: ${this.chatMessages.length} Konversations-Items injiziert`,
          );
        }

        this.log("Starte Mikrofon...");
        void this.startMicrophone();
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

        const reason = this.closeCodeToMessage(event.code, event.reason);

        // Reconnect bei unerwartetem Verbindungsabbruch (z.B. Azure 230s Timeout)

        const isRecoverable =
          !this.intentionalClose &&
          wasActive &&
          event.code !== 1008 && // Policy violation (Auth-Fehler)
          event.code !== 1007 && // Invalid payload / Agent not found
          this.reconnectAttempt < VoiceLiveControl.MAX_RECONNECT_ATTEMPTS;

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

      this.setState("error", `Fehler: ${msg.slice(0, 80)}`);
    }
  }

  /** Wartet mit exponentiellem Backoff und startet dann eine neue Session. */
  private attemptReconnect(): void {
    this.reconnectAttempt++;

    const delay =
      VoiceLiveControl.RECONNECT_BASE_DELAY_MS *
      Math.pow(2, this.reconnectAttempt - 1);

    this.setState("reconnecting");

    this.log(
      `Reconnect ${this.reconnectAttempt}/${VoiceLiveControl.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      void this.startSession(true);
    }, delay);
  }

  private closeCodeToMessage(code: number, reason: string): string {
    const map: Record<number, string> = {
      1006: "Keine Verbindung \u2013 Endpoint-URL pr\u00fcfen",
      1007: "Agent nicht gefunden oder fehlerhafte Anfrage",
      1008: "Richtlinienversto\u00df \u2013 API-Key oder Berechtigungen pr\u00fcfen",
      1011: "Interner Serverfehler",
    };

    return (
      map[code] ??
      (reason
        ? `Fehler ${code}: ${reason}`
        : `Verbindung getrennt (Code ${code})`)
    );
  }

  /**
     * Verarbeitet eingehende Events vom Voice Live Server.
     *
     * Kompatible Events (identisch zur Realtime API):
     *   - input_audio_buffer.speech_started/stopped
     *   - response.created / response.audio.delta / response.done
     *   - response.audio_transcript.delta / .done
     *   - conversation.item.input_audio_transcription.completed
     *   - error
     *
     * Neue Events (Voice Live spezifisch):
     *   - conversation.item.input_audio_transcription.delta (Streaming User-Transkript)
     *   - warning (informational, session bleibt offen)
     */

  private handleServerEvent(msg: ServerEvent): void {
    this.log(`← ${msg.type}`);

    switch (msg.type) {
      case "session.created":
        this.log("Session erfolgreich konfiguriert");
        if (!this.greetingSent) {
          const greetingText = this.userName
            ? `[SYSTEM-HINWEIS] Begrüße den Benutzer "${this.userName}" persönlich mit Vornamen. Stelle dich als Kora vor.`
            : "[SYSTEM-HINWEIS] Begrüße den Benutzer kurz und freundlich. Stelle dich als Kora vor.";
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
        }
        break;

      case "input_audio_buffer.speech_started": {
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
        this.setState("listening");
        break;

      case "response.created":
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
        break;

      case "mcp_list_tools.in_progress":
      case "mcp_list_tools.completed":
        break;

      case "response.output_item.done":
      case "conversation.item.created":
      case "conversation.item.done":
      case "response.content_part.added":
      case "response.content_part.done":
      case "input_audio_buffer.committed":
      case "session.updated":
      case "response.audio.done":
        // Bekannte Events ohne spezielle Behandlung
        break;

      case "response.audio.delta":
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
      case "response.audio_transcript.delta":
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

      case "response.audio_transcript.done":
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

        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.setState("error", errMsg);
        }

        break;
      }
    }
  }

  private getAudioContext(): AudioContext {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    return new Ctx();
  }

  private resample(input: Float32Array, fromRate: number): Float32Array {
    if (fromRate === 24000) return input;
    const ratio = fromRate / 24000;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  }

  /**
     * Mikrofon-Aufnahme starten und Audio-Pipeline aufbauen.
     *
     * Pipeline:
     *   Mikrofon → MediaStreamSource → ScriptProcessor → Resample → PCM16 → Base64 → WebSocket
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

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.audioContext = this.getAudioContext();

      const nativeRate = this.audioContext.sampleRate;

      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      this.nextPlayTime = this.audioContext.currentTime;

      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream,
      );

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.scriptProcessor = this.audioContext.createScriptProcessor(
        4096,
        1,
        1,
      );

      source.connect(this.scriptProcessor);

      this.scriptProcessor.connect(this.audioContext.destination);

      this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (this.ws?.readyState !== WebSocket.OPEN || this.isMuted) return;

        const raw = e.inputBuffer.getChannelData(0);
        const input = this.resample(raw, nativeRate);
        const pcm16 = this.float32ToPcm16(input);
        const base64 = this.bufferToBase64(pcm16.buffer as ArrayBuffer);
        this.sendJson({ type: "input_audio_buffer.append", audio: base64 });
      };

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

  private startVisualization(): void {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const barCount = this.vuBars.length;

    const tick = () => {
      this.animationFrameId = requestAnimationFrame(tick);
      this.analyser!.getByteFrequencyData(dataArray);
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

  private playAudioDelta(base64: string): void {
    if (!this.audioContext) return;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);

    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32.length,
      24000,
    );

    audioBuffer.getChannelData(0).set(float32);
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
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
    };

    this.activeSources.push(source);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

  private float32ToPcm16(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);

    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));

      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    return output;
  }

  private bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);

    let binary = "";

    for (const byte of bytes) binary += String.fromCharCode(byte);

    return btoa(binary);
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

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

  // ══════════════════════════════════════════════════════════════════════

  //  CHAT-PANEL – WhatsApp-Style Transkript-Anzeige

  // ══════════════════════════════════════════════════════════════════════

  private toggleChat(): void {
    this.chatOpen = !this.chatOpen;
    this.container.classList.toggle("chat-open", this.chatOpen);

    if (this.chatOpen) this.scrollToBottom();
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

  private scrollToBottom(): void {
    const el = this.chatPanel;

    if (!el) return;

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;

    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private clearChat(): void {
    this.chatMessages = [];
    this.lastAiBubbleEl = null;
    this.lastUserBubbleEl = null;

    if (this.chatMessagesEl) {
      this.chatMessagesEl.innerHTML =
        '<p class="ai-chat-empty">Gespräch starten, um Transkript zu sehen</p>';
    }
  }

  private toggleConnection(): void {
    const isConfigured = !!(
      this.agentId &&
      this.agentProjectName &&
      this.tokenEndpoint &&
      this.proxyKey &&
      this.agentendpoint
    );

    if (!isConfigured) {
      this.log("FEHLER: Kann nicht verbinden, Konfiguration unvollständig.");

      return;
    }

    const currentlyActive =
      this.controlState !== "idle" &&
      this.controlState !== "error" &&
      this.controlState !== "reconnecting";

    if (currentlyActive) {
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

  private stopSession(): void {
    this.intentionalClose = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    this.reconnectAttempt = 0;
    this.cleanup();
    this.setState("idle");
  }

  /** Räumt nur WS + Audio auf, behält Chat/Transkript für Reconnect. */
  private cleanupConnection(): void {
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

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    if (this.orbEl) this.orbEl.style.transform = "";

    this.vuBars.forEach((b) => {
      b.style.height = "3px";
    });

    this.activeSources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* */
      }
    });

    this.activeSources = [];
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupConnection();
  }

  public getOutputs(): IOutputs {
    return {
      Connected: this.controlState !== "idle" && this.controlState !== "error",
      ConnectionStatus: this.controlState,
      Transcript: this.transcriptText,
      EventLog: this.eventLogText,
    };
  }

  public destroy(): void {
    this.cleanup();
  }
}
