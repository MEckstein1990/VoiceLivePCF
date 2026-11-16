/**
 * Gemeinsame Typen des Controls. Reine Typdefinitionen ohne Laufzeitcode –
 * jedes Modul darf sie importieren, ohne Zirkel zu erzeugen.
 */

/**
 * Zustandsmodell des Controls – steuert UI-Darstellung und erlaubte Aktionen.
 *
 *   idle ──▶ connecting ──▶ listening ◀──▶ user-speaking
 *                         ▲      ▲                 │
 *                         │      └── ai-speaking◀─┘
 *                         │               │
 *                    Reconnecting◀───── error
 *
 *   dormant: Ruhemodus nach Inaktivität – Verbindung getrennt, Mikrofon aus,
 *            Gesprächsverlauf bleibt erhalten. Nur ein Klick weckt wieder auf.
 */
export type ControlState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "user-speaking"
  | "ai-thinking"
  | "ai-speaking"
  | "dormant"
  | "error";

/**
 * Phasen des Ruhemodus-Ablaufs. Ein einzelnes Feld statt mehrerer Booleans,
 * damit keine inkonsistenten Kombinationen entstehen können.
 *
 *   none ──5 Min ohne Tool-Call──▶ warning ──Audio zu Ende──▶ pending-dormant
 *     ▲                                                              │
 *     └────────── Klick auf Connect ◀── dormant ◀────── Wartezeit ───┘
 */
export type DormancyPhase = "none" | "warning" | "pending-dormant" | "dormant";

/** Wie eine Session gestartet wird – bestimmt UI-Text und Kontext-Injektion. */
export type SessionStartMode = "new" | "reconnect" | "wake";

/** Typisierung für eingehende WebSocket-Nachrichten von Voice Live API. */
export interface ServerEvent {
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
  /** Bestätigte Session-Konfiguration (bei session.updated). */
  session?: {
    audio?: { input?: { echo_cancellation?: { reference_source?: string } } };
  };
}

/** Einzelne Chat-Nachricht für die visuelle Darstellung im Chat-Panel. */
export interface ChatMessage {
  role: "user" | "ai";
  text: string;
}
