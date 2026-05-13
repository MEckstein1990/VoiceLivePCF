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

    // ── Konfiguration (aus Power Apps Properties) ────────────────────────
    private authMode = 'APIKey';
    private apiKey = '';
    private token = '';
    private endpoint = '';
    private modelName = '';
    private systemPrompt = '';

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
                <button class="ai-chat-toggle" title="Chat-Transkript anzeigen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                </button>
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
        `;

        this.orbEl = this.container.querySelector('.ai-voice-orb') as HTMLDivElement;
        this.statusTextEl = this.container.querySelector('.ai-voice-status-text') as HTMLParagraphElement;
        this.statusHeaderEl = this.container.querySelector('.ai-voice-status-header') as HTMLSpanElement;
        this.configWarningEl = this.container.querySelector('.ai-voice-config-warning') as HTMLDivElement;
        this.vuBars = Array.from(this.container.querySelectorAll('.ai-voice-bar')) as HTMLDivElement[];
        this.chatToggleBtn = this.container.querySelector('.ai-chat-toggle') as HTMLButtonElement;
        this.chatPanel = this.container.querySelector('.ai-chat-panel') as HTMLDivElement;
        this.chatMessagesEl = this.container.querySelector('.ai-chat-messages') as HTMLDivElement;

        this.chatToggleBtn.addEventListener('click', () => this.toggleChat());
        this.container.className = 'ai-voice-container state-idle';
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this.authMode = context.parameters.AuthMode.raw ?? 'APIKey';
        this.apiKey = context.parameters.APIKey.raw ?? '';
        this.token = context.parameters.Token.raw ?? '';
        this.endpoint = context.parameters.Endpoint.raw ?? '';
        this.modelName = context.parameters.ModelName.raw ?? '';
        this.systemPrompt = context.parameters.SystemPrompt.raw ?? '';

        const hasBase = !!(this.endpoint && this.modelName);
        let configured = false;
        let warning = '';

        if (this.authMode === 'OAuthToken') {
            configured = hasBase && !!this.token;
            warning = '\u26A0 Token, Endpoint und ModelName m\u00FCssen konfiguriert sein (AuthMode: OAuthToken)';
        } else {
            configured = hasBase && !!this.apiKey;
            warning = '\u26A0 APIKey, Endpoint und ModelName m\u00FCssen konfiguriert sein (AuthMode: APIKey)';
        }

        if (this.configWarningEl) {
            this.configWarningEl.textContent = warning;
            this.configWarningEl.classList.toggle('visible', !configured);
        }

        const isActive = context.parameters.Connected.raw === true;
        if (isActive !== this.previousIsActive) {
            this.previousIsActive = isActive;
            if (isActive && configured && this.controlState === 'idle') {
                void this.startSession();
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
     *   wss://{host}/voice-live/realtime?api-version=2025-10-01&model=...&api-key=...
     */
    private async startSession(): Promise<void> {
        const hasAuth = this.authMode === 'OAuthToken' ? !!this.token : !!this.apiKey;
        if (!hasAuth || !this.endpoint || !this.modelName) return;

        this.setState('connecting');

        try {
            const host = this.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
            const authParam = this.authMode === 'OAuthToken'
                ? `&access_token=${encodeURIComponent(this.token)}`
                : `&api-key=${encodeURIComponent(this.apiKey)}`;
            const wsUrl = [
                `wss://${host}/voice-live/realtime`,
                `?api-version=2025-10-01`,
                `&model=${encodeURIComponent(this.modelName)}`,
                authParam,
            ].join('');

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this.transcriptText = '';
                this.currentAiTranscript = '';
                this.currentUserTranscript = '';
                this.clearChat();

                const prompt = this.systemPrompt || VoiceLiveControl.DEFAULT_SYSTEM_PROMPT;

                this.sendJson({
                    type: 'session.update',
                    session: {
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
                        temperature: 0.6,
                        instructions: prompt,
                    },
                });
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
                this.setState('error', 'Verbindung fehlgeschlagen \u2013 Endpoint oder API-Key pr\u00fcfen');
                this.cleanup();
            };

            this.ws.onclose = (event: CloseEvent) => {
                if (this.controlState === 'idle' || this.controlState === 'error') return;
                const reason = this.closeCodeToMessage(event.code, event.reason);
                this.cleanup();
                this.setState('error', reason);
            };
        } catch {
            this.setState('error', 'Unbekannter Fehler beim Verbindungsaufbau');
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
