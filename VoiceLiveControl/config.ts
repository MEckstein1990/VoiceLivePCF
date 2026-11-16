/**
 * Konfiguration des Controls: Defaults, Auswertung der Power-Apps-Properties
 * und feste Zeitkonstanten.
 */

// #region Schalter

/**
 * Schaltet Live-Reference AEC ein: Der Client sendet zusätzlich zum Mikrofon
 * das tatsächlich abgespielte Signal als zweiten Kanal, damit der Server das
 * Echo sauber herausrechnen kann.
 *
 * Steht auf false, weil der WebSocket-Proxy dafür **api-version 2026-07-15
 * oder neuer** braucht. Mit einer älteren Version quittiert der Server die
 * Konfiguration stillschweigend nicht – und da wir trotzdem Stereo senden
 * würden, läse er es als Mono und verstünde gar nichts mehr.
 *
 * Solange aus: Die Echounterdrückung macht das Gerät (echoCancellation im
 * getUserMedia). Preis ist der Kommunikationsmodus auf Android, wodurch die
 * Lautstärketasten auf den Anruf-Stream zeigen, die Wiedergabe aber auf
 * Musik landet – die Tasten greifen dann ab der zweiten Verbindung nicht.
 *
 * Umlegen, sobald der Proxy aktualisiert ist. Ob es greift, meldet der
 * session.updated-Handler im Log.
 */
export const USE_LIVE_REFERENCE_AEC = false;

// #endregion

// #region Zeitkonstanten

/** Tick-Intervall der Inaktivitätsprüfung. */
export const IDLE_CHECK_INTERVAL_MS = 10_000;
/** Mindestruhe im Gespräch, bevor die Ansage gesendet wird (verhindert Response-Kollision). */
export const QUIET_GATE_MS = 3_000;
/** Nach dieser Zeit wird die Ansage trotz laufendem Gespräch erzwungen. */
export const MAX_DEFER_MS = 60_000;
/** Not-Aus, falls die Ansage nie beantwortet wird. */
export const WARNING_WATCHDOG_MS = 60_000;

export const MAX_RECONNECT_ATTEMPTS = 5;
export const RECONNECT_BASE_DELAY_MS = 1500;

// Reserve für eine App, die das Event OnTokenNeeded gar nicht beantwortet.
// Fehler der App kommen sofort an. Großzügig, weil der erste Aufruf ein kaltes
// Backend treffen kann.
export const TOKEN_WAIT_MS = 20_000;

// #endregion

// #region Defaults (werden durch Power Apps Properties überschrieben)

export const DEFAULT_AGENT_VOICE = "de-DE-Florian:DragonHDLatestNeural";
export const DEFAULT_AGENT_LANGUAGE = "de";
export const DEFAULT_SILENCE_DURATION = 2000;
export const DEFAULT_VAD_THRESHOLD = 0.5;
export const DEFAULT_VOICE_SPEED = "1.0";
export const DEFAULT_USER_NAME = "";
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;
export const DEFAULT_DORMANT_DELAY_SECONDS = 5;

// #endregion

// #region Auswertung der Properties

/** Die Werte, die das Control aus den Power-Apps-Properties übernimmt. */
export interface ControlConfig {
  agentVoice: string;
  agentLanguage: string;
  voiceSpeed: string;
  silenceDurationMs: number;
  vadThreshold: number;
  userName: string;
  dormantEnabled: boolean;
  idleTimeoutMs: number;
  dormantDelayMs: number;
}

interface RawValue<T> {
  raw: T | null | undefined;
}

/**
 * Teilmenge von `context.parameters`, die readConfig liest. Strukturell
 * kompatibel mit den generierten IInputs, in Tests als einfaches Objekt baubar.
 */
export interface ConfigParameters {
  AgentVoice: RawValue<string>;
  AgentLanguage: RawValue<string>;
  VoiceSpeed: RawValue<string>;
  UserName: RawValue<string>;
  SilenceDurationMs: RawValue<number>;
  VadThreshold: RawValue<number>;
  DormantEnabled: RawValue<boolean>;
  IdleTimeoutMinutes: RawValue<number>;
  DormantDelaySeconds: RawValue<number>;
}

/** Konfiguration vor dem ersten updateView – entspricht den Defaults. */
export const INITIAL_CONFIG: ControlConfig = {
  agentVoice: DEFAULT_AGENT_VOICE,
  agentLanguage: DEFAULT_AGENT_LANGUAGE,
  voiceSpeed: DEFAULT_VOICE_SPEED,
  silenceDurationMs: DEFAULT_SILENCE_DURATION,
  vadThreshold: DEFAULT_VAD_THRESHOLD,
  userName: DEFAULT_USER_NAME,
  dormantEnabled: true,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000,
  dormantDelayMs: DEFAULT_DORMANT_DELAY_SECONDS * 1000,
};

/** Liest die Properties und ersetzt fehlende oder ungültige Werte durch Defaults. */
export function readConfig(p: ConfigParameters): ControlConfig {
  // PCF-Testharnisch liefert "val" als Platzhalter für alle Properties –
  // in diesem Fall greifen die eingebauten Defaults.
  const prop = (raw: string | null | undefined, def: string): string =>
    raw && raw !== "val" && raw !== "undefined" ? raw : def;

  // Clamp auf >= 1: Ein Maker mit 0 würde sonst eine Ansage-Endlosschleife erzeugen.
  const idleMinutes =
    typeof p.IdleTimeoutMinutes.raw === "number" && p.IdleTimeoutMinutes.raw > 0
      ? p.IdleTimeoutMinutes.raw
      : DEFAULT_IDLE_TIMEOUT_MINUTES;

  const dormantSeconds =
    typeof p.DormantDelaySeconds.raw === "number" && p.DormantDelaySeconds.raw > 0
      ? p.DormantDelaySeconds.raw
      : DEFAULT_DORMANT_DELAY_SECONDS;

  return {
    agentVoice: prop(p.AgentVoice.raw, DEFAULT_AGENT_VOICE),
    agentLanguage: prop(p.AgentLanguage.raw, DEFAULT_AGENT_LANGUAGE),
    voiceSpeed: prop(p.VoiceSpeed.raw, DEFAULT_VOICE_SPEED),
    silenceDurationMs:
      typeof p.SilenceDurationMs.raw === "number"
        ? p.SilenceDurationMs.raw
        : DEFAULT_SILENCE_DURATION,
    vadThreshold:
      typeof p.VadThreshold.raw === "number"
        ? p.VadThreshold.raw
        : DEFAULT_VAD_THRESHOLD,
    userName: prop(p.UserName.raw, DEFAULT_USER_NAME),
    // TwoOptions hier bewusst mit !== false statt === true:
    // Im Testharnisch ist raw null, das würde den Default true aushebeln.
    dormantEnabled: p.DormantEnabled.raw !== false,
    idleTimeoutMs: Math.max(1, idleMinutes) * 60_000,
    dormantDelayMs: Math.max(1, dormantSeconds) * 1000,
  };
}

// #endregion
