/**
 * Voice Live API – Real-time Voice Chat – PCF Control
 *
 * Dieses Control ermöglicht einen bidirektionalen Echtzeit-Sprach-Dialog
 * über die Azure Voice Live API direkt aus einer Power Apps / Dynamics 365 Oberfläche.
 *
 * Unterschiede zur Azure OpenAI Realtime API (HelloWorldControl):
 *   - WSS-Endpoint: /voice-live/realtime statt /openai/realtime
 *   - Modell statt Deployment (model= statt deployment=)
 *   - Azure Semantic VAD (multilingual) statt Server VAD
 *   - Built-in Noise Suppression (azure_deep_noise_suppression)
 *   - Built-in Echo Cancellation (server_echo_cancellation)
 *   - Azure Speech STT statt Whisper-1
 *   - Voice-Objekt-Struktur: {type: "openai", name: "alloy"} statt String
 *   - Kein manueller Noise Gate nötig (Server macht das)
 *
 * Konfiguration erfolgt über Power Apps Properties:
 *   - APIKey:    Azure Foundry API-Schlüssel
 *   - Endpoint:  Foundry Endpoint-URL (z. B. https://myresource.cognitiveservices.azure.com)
 *   - ModelName: Name des Modells (z. B. gpt-4.1)
 *   - IsActive:  Boolean (bound) – steuert Session-Start/-Stop von Power Apps aus
 */
import { IInputs, IOutputs } from "./generated/ManifestTypes";

/**
 * Zustandsmodell des Controls – steuert UI-Darstellung und erlaubte Aktionen.
 *
 *   idle ──▶ connecting ──▶ listening ◀──▶ user-speaking
 *                                ▲               │
 *                                └── ai-speaking ─┘
 *                                        │
 *                                      error
 */
type ControlState = 'idle' | 'connecting' | 'listening' | 'user-speaking' | 'ai-speaking' | 'error';

/** Typisierung für eingehende WebSocket-Nachrichten von Voice Live API. */
interface ServerEvent {
    type: string;
    /** Base64-kodierter Audio-Chunk (nur bei `response.audio.delta`). */
    delta?: string;
    /** Transkript-Text (bei Transkriptions-Events). */
    transcript?: string;
    error?: { message: string };
    warning?: { message: string };
}

/** Einzelne Chat-Nachricht für die visuelle Darstellung im Chat-Panel. */
interface ChatMessage {
    role: 'user' | 'ai';
    text: string;
}

export class VoiceLiveControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {

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
    private controlState: ControlState = 'idle';
    private previousIsActive: boolean | null = null;

    // ── Transkript ───────────────────────────────────────────────────────
    private transcriptText = '';
    private currentAiTranscript = '';
    private currentUserTranscript = '';

    // ── Chat-UI ──────────────────────────────────────────────────────────
    private chatMessages: ChatMessage[] = [];
    private chatOpen = false;

    // ── Event-Log (Debug) ────────────────────────────────────────────────
    private eventLogEntries: string[] = [];
    private eventLogOpen = true;
    private eventLogEl!: HTMLDivElement;
    private eventLogToggleBtn!: HTMLButtonElement;
    private loggedInit = false;

    // ── Konfiguration (aus Power Apps Properties) ────────────────────────
    private authMode = 'APIKey';
    private apiKey = '';
    private token = '';
    private endpoint = '';
    private modelName = '';
    private systemPrompt = '';
    private agentId = '';
    private agentProjectName = '';
    private tokenEndpoint = '';
    private proxyKey = '';
    /** Dynamisch vom Backend geholter Token – wird nach Session-Ende verworfen. */
    private fetchedToken = '';

    // ── Agent-Defaults (werden durch Power Apps Properties überschrieben) ─────
    private static readonly DEFAULT_AGENT_ENDPOINT    = 'https://test-speechlive-mcp.services.ai.azure.com';
    private static readonly DEFAULT_AGENT_ID          = 'dataverse-proxy-playground-agent-v3';
    private static readonly DEFAULT_AGENT_PROJECT     = 'proj-default';
    private static readonly DEFAULT_AGENT_AUTH_MODE   = 'OAuthToken';
    private static readonly DEFAULT_TOKEN_ENDPOINT    = 'https://voicelivesessionapi-fgc4ebcfcnc3awef.germanywestcentral-01.azurewebsites.net';
    private static readonly DEFAULT_PROXY_KEY         = 'qXKfGt8HOB9gNVQncysd1MAjYvo2bCz64wTIiZUlRLxrE057';

    /** Standard-System-Prompt für den Außendienst-Assistenten. */
    private static readonly DEFAULT_SYSTEM_PROMPT = [
        'Du bist ein professioneller Außendienst-Assistent für Servicetechniker und Berater.',
        'Du sprichst Deutsch und antwortest knapp, sachlich und präzise.',
        '',
        'GESPRÄCHSFÜHRUNG:',
        '- Begrüße den User kurz und frage, wie du helfen kannst.',
        '- Wenn der User ein Protokoll, einen Bericht oder eine Dokumentation diktieren möchte,',
        '  wechsle in den Zuhör-Modus: Antworte dann NUR mit minimalen Bestätigungen',
        '  wie "Verstanden", "Mhm", "Weiter" oder "Notiert".',
        '- Unterbrich den User NIEMALS während er diktiert.',
        '- Wenn der User länger schweigt, frage kurz: "Möchtest du noch etwas ergänzen?"',
        '- Wenn der User sagt er ist fertig, fasse das Gesagte strukturiert zusammen.',
        '',
        'STIL:',
        '- Kurze Sätze, kein Smalltalk.',
        '- Verwende Fachsprache wenn der User sie benutzt.',
        '- Keine Floskeln wie "Natürlich!" oder "Gerne!".',
    ].join('\n');

    // ── DOM-Referenzen ───────────────────────────────────────────────────
    private orbEl!: HTMLDivElement;
    private statusTextEl!: HTMLParagraphElement;
    private statusHeaderEl!: HTMLSpanElement;
    private vuBars!: HTMLDivElement[];
    private configWarningEl!: HTMLDivElement;
    private chatToggleBtn!: HTMLButtonElement;
    private chatPanel!: HTMLDivElement;
    private chatMessagesEl!: HTMLDivElement;
    private lastAiBubbleEl: HTMLDivElement | null = null;
    private lastUserBubbleEl: HTMLDivElement | null = null;

    constructor() { /* Pflicht-Konstruktor für das PCF-Framework */ }

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement
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
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                    </button>
                    <!-- <button class="ai-log-toggle" title="Event-Log" style="background:none;border:1px solid #555;color:#aaa;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;line-height:1.4">LOG</button> -->
                </div>
            </div>
            <div class="ai-voice-orb-area">
                <div class="ai-voice-orb-wrapper">
                    <div class="ai-voice-ring ai-voice-ring-1"></div>
                    <div class="ai-voice-ring ai-voice-ring-2"></div>
                    <div class="ai-voice-ring ai-voice-ring-3"></div>
                    <div class="ai-voice-orb">
                        <svg class="ai-voice-orb-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-1 14.93V19H9v2h6v-2h-2v-2.07A7.001 7.001 0 0 0 19 11h-2a5 5 0 0 1-10 0H5a7.001 7.001 0 0 0 6 6.93z"/>
                        </svg>
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
                <p class="ai-voice-status-text">Inaktiv</p>
                <div class="ai-voice-config-warning">&#x26A0; APIKey, Endpoint und ModelName m&#xFC;ssen konfiguriert sein</div>
            </div>
            <!-- <div class="ai-event-log" style="display:block;position:relative;background:#111;color:#0f0;font-family:monospace;font-size:10px;padding:6px 8px;overflow-y:auto;max-height:140px;white-space:pre-wrap;word-break:break-all;border-top:1px solid #333;flex-shrink:0">Warte auf Events...</div> -->
        `;

        this.orbEl = this.container.querySelector('.ai-voice-orb') as HTMLDivElement;
        this.statusTextEl = this.container.querySelector('.ai-voice-status-text') as HTMLParagraphElement;
        this.statusHeaderEl = this.container.querySelector('.ai-voice-status-header') as HTMLSpanElement;
        this.configWarningEl = this.container.querySelector('.ai-voice-config-warning') as HTMLDivElement;
        this.vuBars = Array.from(this.container.querySelectorAll('.ai-voice-bar')) as HTMLDivElement[];
        this.chatToggleBtn = this.container.querySelector('.ai-chat-toggle') as HTMLButtonElement;
        this.chatPanel = this.container.querySelector('.ai-chat-panel') as HTMLDivElement;
        this.chatMessagesEl = this.container.querySelector('.ai-chat-messages') as HTMLDivElement;
        // this.eventLogEl = this.container.querySelector('.ai-event-log') as HTMLDivElement;
        // this.eventLogToggleBtn = this.container.querySelector('.ai-log-toggle') as HTMLButtonElement;

        this.chatToggleBtn.addEventListener('click', () => this.toggleChat());
        // this.eventLogToggleBtn.addEventListener('click', () => this.toggleEventLog());
        this.container.className = 'ai-voice-container state-idle';
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        // PCF-Testharnisch liefert "val" als Platzhalter für alle Properties –
        // in diesem Fall greifen die eingebauten Defaults.
        const prop = (raw: string | null | undefined, def: string): string =>
            (raw && raw !== 'val' && raw !== 'undefined') ? raw : def;
        const propRaw = (raw: string | null | undefined): string =>
            (raw && raw !== 'val' && raw !== 'undefined') ? raw : '';

        this.authMode         = prop(context.parameters.AuthMode.raw,         VoiceLiveControl.DEFAULT_AGENT_AUTH_MODE);
        this.apiKey           = propRaw(context.parameters.APIKey.raw);
        this.token            = propRaw(context.parameters.Token.raw);
        this.endpoint         = prop(context.parameters.Endpoint.raw,         VoiceLiveControl.DEFAULT_AGENT_ENDPOINT);
        this.modelName        = propRaw(context.parameters.ModelName.raw);
        this.systemPrompt     = propRaw(context.parameters.SystemPrompt.raw);
        this.agentId          = prop(context.parameters.AgentId.raw,          VoiceLiveControl.DEFAULT_AGENT_ID);
        this.agentProjectName = prop(context.parameters.AgentProjectName.raw, VoiceLiveControl.DEFAULT_AGENT_PROJECT);
        this.tokenEndpoint    = prop(context.parameters.TokenEndpoint.raw,    VoiceLiveControl.DEFAULT_TOKEN_ENDPOINT);
        this.proxyKey         = prop(context.parameters.ProxyKey.raw,         VoiceLiveControl.DEFAULT_PROXY_KEY);

        const isAgentMode = !!this.agentId;
        let configured = false;
        let warning = '';

        if (!this.loggedInit) {
            this.loggedInit = true;
            this.log(`Init: agentMode=${isAgentMode}, endpoint=${this.endpoint}`);
            this.log(`agentId=${this.agentId}, tokenEndpoint=${this.tokenEndpoint}`);
        }

        if (isAgentMode) {
            // Token kommt entweder direkt als Property oder wird zur Laufzeit
            // vom TokenEndpoint geholt (GET /api/voice-live/token)
            configured = !!(this.token || this.tokenEndpoint);
            warning = '\u26A0 Token fehlt \u2013 TokenEndpoint setzen oder OAuth-Token direkt übergeben';
        } else if (this.authMode === 'OAuthToken') {
            configured = !!(this.endpoint && this.modelName && this.token);
            warning = '\u26A0 Token, Endpoint und ModelName m\u00FCssen konfiguriert sein (AuthMode: OAuthToken)';
        } else {
            configured = !!(this.endpoint && this.modelName && this.apiKey);
            warning = '\u26A0 APIKey, Endpoint und ModelName m\u00FCssen konfiguriert sein (AuthMode: APIKey)';
        }

        if (this.configWarningEl) {
            this.configWarningEl.textContent = warning;
            this.configWarningEl.classList.toggle('visible', !configured);
        }

        const isActive = context.parameters.Connected.raw === true;
        if (isActive !== this.previousIsActive) {
            this.previousIsActive = isActive;
            this.log(`Connected=${isActive}, configured=${configured}, state=${this.controlState}`);
            if (isActive && configured && this.controlState === 'idle') {
                void this.startSession();
            } else if (isActive && !configured) {
                this.log('FEHLER: Nicht konfiguriert – kein Token/Endpoint vorhanden');
            } else if (!isActive && this.controlState !== 'idle') {
                this.stopSession();
            }
        }
    }

    private setState(newState: ControlState, errorDetail?: string): void {
        this.controlState = newState;

        const classes = ['ai-voice-container'];
        classes.push(`state-${newState}`);
        if (['listening', 'user-speaking', 'ai-speaking'].includes(newState)) {
            classes.push('state-connected');
        }
        if (['connecting', 'listening', 'user-speaking', 'ai-speaking'].includes(newState)) {
            classes.push('state-active');
        }
        if (this.chatOpen) {
            classes.push('chat-open');
        }
        this.container.className = classes.join(' ');

        const labels: Record<ControlState, { text: string; header: string }> = {
            idle:            { text: 'Inaktiv',              header: 'Nicht verbunden' },
            connecting:      { text: 'Verbinde\u2026',      header: 'Verbinde\u2026' },
            listening:       { text: 'Ich h\u00f6re zu\u2026', header: 'Verbunden (Voice Live)' },
            'user-speaking': { text: 'Du sprichst\u2026',   header: 'Verbunden (Voice Live)' },
            'ai-speaking':   { text: 'KI spricht\u2026',    header: 'Verbunden (Voice Live)' },
            error:           { text: errorDetail ?? 'Verbindungsfehler', header: 'Fehler' },
        };

        const info = labels[newState];
        if (this.statusTextEl) this.statusTextEl.textContent = info.text;
        if (this.statusHeaderEl) this.statusHeaderEl.textContent = info.header;
        if (this.orbEl) this.orbEl.style.transform = '';
        this.notifyOutputChanged();
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
        const url = `${this.tokenEndpoint.replace(/\/$/, '')}/api/voice-live/token`;
        const headers: Record<string, string> = {};
        if (this.proxyKey) headers['X-Proxy-Key'] = this.proxyKey;
        const resp = await fetch(url, { headers });
        if (!resp.ok) throw new Error(`Token-Endpoint Fehler ${resp.status}`);
        const data = await resp.json() as { token: string };
        if (!data.token) throw new Error('Token-Endpoint hat kein token-Feld zurückgegeben');
        return data.token;
    }

    private async startSession(): Promise<void> {
        const isAgentMode = !!this.agentId;

        if (isAgentMode) {
            if (!this.endpoint || !this.agentId || !this.agentProjectName) return;
            if (!this.token && !this.tokenEndpoint) return;
        } else {
            const hasAuth = this.authMode === 'OAuthToken' ? !!this.token : !!this.apiKey;
            if (!hasAuth || !this.endpoint || !this.modelName) return;
        }

        this.setState('connecting');

        try {
            let wsUrl: string;

            if (isAgentMode) {
                // Agent-Modus: WebSocket-Proxy in der Function App übernimmt die Auth
                // (Authorization: Bearer Header – Browser-WebSocket kann das nicht selbst setzen)
                const proxyHost = this.tokenEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
                wsUrl = `wss://${proxyHost}/api/voice-live/ws` +
                        `?key=${encodeURIComponent(this.proxyKey)}` +
                        `&agent-name=${encodeURIComponent(this.agentId)}` +
                        `&agent-project-name=${encodeURIComponent(this.agentProjectName)}`;
            } else {
                const host = this.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
                const authParam = this.authMode === 'OAuthToken'
                    ? `&access_token=${encodeURIComponent(this.token)}`
                    : `&api-key=${encodeURIComponent(this.apiKey)}`;
                wsUrl = [
                    `wss://${host}/voice-live/realtime`,
                    `?api-version=2026-01-01-preview`,
                    `&model=${encodeURIComponent(this.modelName)}`,
                    authParam,
                ].join('');
            }

            this.ws = new WebSocket(wsUrl);
            this.log(`WebSocket öffnet: wss://${wsUrl.split('//')[1]?.split('?')[0] ?? '?'}`);

            this.ws.onopen = () => {
                this.log('WebSocket geöffnet, sende session.update...');
                this.transcriptText = '';
                this.currentAiTranscript = '';
                this.currentUserTranscript = '';
                this.clearChat();

                // Im Agent-Modus keine instructions senden – der Agent hat seinen eigenen System-Prompt
                const sessionPayload: Record<string, unknown> = {
                    modalities: ['text', 'audio'],
                    voice: {
                        type: 'azure-standard',
                        name: 'de-DE-Florian:DragonHDLatestNeural',
                    },
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    input_audio_sampling_rate: 24000,
                    turn_detection: {
                        type: 'azure_semantic_vad_multilingual',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                        languages: ['de'],
                        remove_filler_words: true,
                    },
                    input_audio_noise_reduction: {
                        type: 'azure_deep_noise_suppression',
                    },
                    input_audio_echo_cancellation: {
                        type: 'server_echo_cancellation',
                    },
                    input_audio_transcription: {
                        model: 'azure-speech',
                        language: 'de',
                    },
                };

                if (!isAgentMode) {
                    const prompt = this.systemPrompt || VoiceLiveControl.DEFAULT_SYSTEM_PROMPT;
                    sessionPayload['instructions'] = prompt;
                    sessionPayload['temperature'] = 0.6;
                }

                this.sendJson({ type: 'session.update', session: sessionPayload });
                this.log('session.update gesendet, starte Mikrofon...');
                void this.startMicrophone();
                this.setState('listening');
            };

            this.ws.onmessage = (event: MessageEvent) => {
                try {
                    const msg = JSON.parse(event.data as string) as ServerEvent;
                    this.handleServerEvent(msg);
                } catch { /* ignore malformed frames */ }
            };

            this.ws.onerror = () => {
                // Nicht cleanup() aufrufen – onclose feuert immer danach und hat den Close-Code
                this.log('WebSocket onerror ausgelöst – warte auf onclose für Details...');
            };

            this.ws.onclose = (event: CloseEvent) => {
                this.log(`WebSocket geschlossen: Code=${event.code} Reason="${event.reason || '(kein)'}"`);
                const wasActive = this.controlState !== 'idle' && this.controlState !== 'error';
                const reason = this.closeCodeToMessage(event.code, event.reason);
                this.cleanup();
                if (wasActive) {
                    this.setState('error', reason);
                } else {
                    // Auch bei onerror-Pfad: Fehlermeldung setzen
                    this.setState('error', reason || 'WebSocket-Fehler – Endpoint oder Token prüfen');
                }
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`startSession Fehler: ${msg}`);
            this.setState('error', `Fehler: ${msg.slice(0, 80)}`);
        }
    }

    private closeCodeToMessage(code: number, reason: string): string {
        const map: Record<number, string> = {
            1006: 'Keine Verbindung \u2013 Endpoint-URL pr\u00fcfen',
            1008: 'Richtlinienversto\u00df \u2013 API-Key oder Berechtigungen pr\u00fcfen',
            1011: 'Interner Serverfehler',
        };
        return map[code] ?? (reason ? `Fehler ${code}: ${reason}` : `Verbindung getrennt (Code ${code})`);
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
        switch (msg.type) {
            case 'input_audio_buffer.speech_started':
                this.currentUserTranscript = '';
                this.lastUserBubbleEl = null;
                this.setState('user-speaking');
                break;
            case 'input_audio_buffer.speech_stopped':
                this.setState('listening');
                break;
            case 'response.created':
                this.currentAiTranscript = '';
                this.lastAiBubbleEl = null;
                this.chatMessages.push({ role: 'ai', text: '' });
                this.addChatBubble('ai', '\u2026');
                this.setState('ai-speaking');
                break;
            case 'response.audio.delta':
                if (msg.delta) this.playAudioDelta(msg.delta);
                break;
            case 'response.done':
                if (this.currentAiTranscript) {
                    this.transcriptText += `[KI]: ${this.currentAiTranscript}\n`;
                    const lastAi = this.chatMessages.slice().reverse().find((m: ChatMessage) => m.role === 'ai');
                    if (lastAi) lastAi.text = this.currentAiTranscript;
                    this.updateLastAiBubble();
                    this.currentAiTranscript = '';
                    this.notifyOutputChanged();
                }
                this.lastAiBubbleEl = null;
                if (this.controlState === 'ai-speaking') this.setState('listening');
                break;

            // ── Transkriptions-Events ────────────────────────────────────

            // Voice Live: Streaming User-Transkript (Wort für Wort)
            case 'conversation.item.input_audio_transcription.delta':
                if (msg.delta) {
                    this.currentUserTranscript += msg.delta;
                    this.updateLastUserBubble();
                }
                break;

            // Finales User-Transkript (kompatibel mit Realtime API)
            case 'conversation.item.input_audio_transcription.completed':
                if (msg.transcript) {
                    this.currentUserTranscript = msg.transcript;
                    this.transcriptText += `[User]: ${msg.transcript}\n`;

                    // Wenn wir schon eine Streaming-Bubble haben, aktualisiere sie
                    if (this.lastUserBubbleEl) {
                        const lastUser = this.chatMessages.slice().reverse().find((m: ChatMessage) => m.role === 'user');
                        if (lastUser) lastUser.text = msg.transcript;
                        this.lastUserBubbleEl.textContent = msg.transcript;
                    } else {
                        this.chatMessages.push({ role: 'user', text: msg.transcript });
                        this.addChatBubble('user', msg.transcript);
                    }
                    this.currentUserTranscript = '';
                    this.lastUserBubbleEl = null;
                    this.notifyOutputChanged();
                }
                break;

            // KI-Transkript (Streaming)
            case 'response.audio_transcript.delta':
                if (msg.delta) {
                    this.currentAiTranscript += msg.delta;
                    const lastAiDelta = this.chatMessages.slice().reverse().find((m: ChatMessage) => m.role === 'ai');
                    if (lastAiDelta) lastAiDelta.text = this.currentAiTranscript;
                    this.updateLastAiBubble();
                }
                break;
            case 'response.audio_transcript.done':
                if (msg.transcript) {
                    this.currentAiTranscript = msg.transcript;
                    const lastAiDone = this.chatMessages.slice().reverse().find((m: ChatMessage) => m.role === 'ai');
                    if (lastAiDone) lastAiDone.text = msg.transcript;
                    this.updateLastAiBubble();
                }
                break;

            // Voice Live: Warnungen (informational, Session bleibt offen)
            case 'warning':
                // Intentionally ignored – warnings don't interrupt the session
                break;

            case 'error':
                this.setState('error', msg.error?.message ?? 'Serverfehler');
                break;
        }
    }

    private getAudioContext(): AudioContext {
        const Ctx = (window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
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
                this.setState('error', 'getUserMedia nicht verf\u00fcgbar \u2013 HTTPS oder Browser-Support pr\u00fcfen');
                return;
            }
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

            this.audioContext = this.getAudioContext();
            const nativeRate = this.audioContext.sampleRate;

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            this.nextPlayTime = this.audioContext.currentTime;

            const source = this.audioContext.createMediaStreamSource(this.mediaStream);

            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
            source.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);

            this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
                if (this.ws?.readyState !== WebSocket.OPEN) return;

                const raw = e.inputBuffer.getChannelData(0);

                // Kein Noise Gate – Voice Live hat azure_deep_noise_suppression
                const input = this.resample(raw, nativeRate);
                const pcm16 = this.float32ToPcm16(input);
                const base64 = this.bufferToBase64(pcm16.buffer as ArrayBuffer);
                this.sendJson({ type: 'input_audio_buffer.append', audio: base64 });
            };

            this.startVisualization();
        } catch (err: unknown) {
            const name = (err instanceof DOMException) ? err.name : '';
            const messages: Record<string, string> = {
                NotAllowedError:  'Mikrofonberechtigung verweigert \u2013 bitte in den App-Einstellungen erlauben',
                PermissionDeniedError: 'Mikrofonberechtigung verweigert \u2013 bitte in den App-Einstellungen erlauben',
                NotFoundError:    'Kein Mikrofon gefunden',
                NotReadableError: 'Mikrofon wird von einer anderen App verwendet',
                NotSupportedError:'Mikrofon-API nicht unterst\u00fctzt (HTTPS erforderlich)',
                SecurityError:    'Sicherheitseinschr\u00e4nkung \u2013 Seite muss \u00fcber HTTPS geladen sein',
            };
            this.setState('error', messages[name] ?? `Mikrofonfehler: ${name || 'Unbekannt'}`);
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
            for (const v of dataArray) sum += v ** 2;
            const rms = Math.sqrt(sum / dataArray.length) / 255;
            const level = Math.min(rms * 3.5, 1);

            if (this.controlState === 'user-speaking' && this.orbEl) {
                this.orbEl.style.transform = `scale(${(1 + level * 0.35).toFixed(3)})`;
            }

            for (let i = 0; i < barCount; i++) {
                const idx = Math.floor((i / barCount) * dataArray.length * 0.45);
                const h = Math.max(3, (dataArray[idx] / 255) * 26);
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

        const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
        audioBuffer.getChannelData(0).set(float32);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        const startAt = Math.max(this.audioContext.currentTime, this.nextPlayTime);
        source.start(startAt);
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
        let binary = '';
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

    private log(_msg: string): void {
        // const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
        // const entry = `[${ts}] ${_msg}`;
        // this.eventLogEntries.push(entry);
        // if (this.eventLogEntries.length > 200) this.eventLogEntries.shift();
        // if (this.eventLogEl) {
        //     this.eventLogEl.textContent = this.eventLogEntries.join('\n');
        //     this.eventLogEl.scrollTop = this.eventLogEl.scrollHeight;
        // }
        // console.log('[VoiceLive]', _msg);
    }

    private toggleEventLog(): void {
        this.eventLogOpen = !this.eventLogOpen;
        if (this.eventLogEl) {
            if (this.eventLogOpen) {
                this.eventLogEl.style.position = 'relative';
                this.eventLogEl.style.maxHeight = '140px';
                this.eventLogEl.style.zIndex = '';
                this.eventLogEl.style.inset = '';
            } else {
                this.eventLogEl.style.position = 'absolute';
                this.eventLogEl.style.inset = '0';
                this.eventLogEl.style.maxHeight = '';
                this.eventLogEl.style.zIndex = '100';
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  CHAT-PANEL – WhatsApp-Style Transkript-Anzeige
    // ══════════════════════════════════════════════════════════════════════

    private toggleChat(): void {
        this.chatOpen = !this.chatOpen;
        this.container.classList.toggle('chat-open', this.chatOpen);
        if (this.chatOpen) this.scrollToBottom();
    }

    private addChatBubble(role: 'user' | 'ai', text: string): void {
        const emptyEl = this.chatMessagesEl.querySelector('.ai-chat-empty');
        if (emptyEl) emptyEl.remove();

        const bubble = document.createElement('div');
        bubble.className = `ai-chat-bubble ai-chat-${role}`;
        bubble.textContent = text;

        if (role === 'user' && this.lastAiBubbleEl?.parentElement === this.chatMessagesEl) {
            this.chatMessagesEl.insertBefore(bubble, this.lastAiBubbleEl);
        } else {
            this.chatMessagesEl.appendChild(bubble);
        }

        if (role === 'ai') {
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
            this.chatMessages.push({ role: 'user', text: this.currentUserTranscript });
            this.addChatBubble('user', this.currentUserTranscript);
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
            this.chatMessagesEl.innerHTML = '<p class="ai-chat-empty">Gespräch starten, um Transkript zu sehen</p>';
        }
    }

    private stopSession(): void {
        this.cleanup();
        this.fetchedToken = ''; // dynamisch geholten Token verwerfen
        this.setState('idle');
    }

    private cleanup(): void {
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
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            void this.audioContext.close();
            this.audioContext = null;
        }
        if (this.orbEl) this.orbEl.style.transform = '';
        this.vuBars.forEach(b => { b.style.height = '3px'; });
    }

    public getOutputs(): IOutputs {
        return {
            Connected: this.controlState !== 'idle' && this.controlState !== 'error',
            ConnectionStatus: this.controlState,
            Transcript: this.transcriptText,
        };
    }

    public destroy(): void {
        this.cleanup();
    }
}
