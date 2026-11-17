/**
 * Darstellung eines Zustands: CSS-Klassen des Containers, Statustexte und
 * Titel des Verbinden-Buttons. Reine Funktion – das Schreiben in den DOM
 * übernimmt setState() im Control.
 */

import { MAX_RECONNECT_ATTEMPTS } from "../config";
import { ControlState, DormancyPhase } from "../types";

export interface StateViewInput {
  state: ControlState;
  chatOpen: boolean;
  isMuted: boolean;
  dormancyPhase: DormancyPhase;
  reconnectAttempt: number;
  errorDetail?: string;
}

export interface StateView {
  /** Vollständige className des Containers. */
  className: string;
  /** Text unter dem Orb. */
  statusText: string;
  /** Text in der Kopfzeile. */
  header: string;
  /** Tooltip des Verbinden-Buttons. */
  connectTitle: string;
}

/** Zustände mit laufender Verbindung (grüner Punkt). */
const CONNECTED_STATES: ControlState[] = [
  "listening",
  "user-speaking",
  "ai-thinking",
  "ai-speaking",
];

/** Zustände, in denen der Verbinden-Button trennt. */
const ACTIVE_STATES: ControlState[] = [
  "connecting",
  "reconnecting",
  "listening",
  "user-speaking",
  "ai-thinking",
  "ai-speaking",
];

export function describeState(input: StateViewInput): StateView {
  const { state, chatOpen, isMuted, dormancyPhase, reconnectAttempt, errorDetail } = input;

  const classes = ["ai-voice-container"];

  classes.push(`state-${state}`);

  if (CONNECTED_STATES.includes(state)) {
    classes.push("state-connected");
  }

  if (ACTIVE_STATES.includes(state)) {
    classes.push("state-active");
  }

  if (chatOpen) {
    classes.push("chat-open");
  }

  if (isMuted) {
    classes.push("muted");
  }

  // className wird komplett neu gebaut – ein setState während des Countdowns
  // würde den Tipp-Hinweis sonst wegwischen.
  if (dormancyPhase === "pending-dormant") {
    classes.push("dormant-pending");
  }

  const labels: Record<ControlState, { text: string; header: string }> = {
    idle: { text: "Inaktiv", header: "Nicht verbunden" },

    connecting: { text: "Verbinde…", header: "Verbinde…" },

    reconnecting: {
      text: `Verbindung wiederherstellen (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})…`,
      header: "Verbindung unterbrochen",
    },

    listening: {
      text: "Ich höre zu…",
      header: "Verbunden",
    },

    "user-speaking": {
      text: "Du sprichst…",
      header: "Verbunden",
    },

    "ai-thinking": {
      text: "KoRa denkt nach…",
      header: "Verbunden",
    },

    "ai-speaking": {
      text: "KoRa spricht…",
      header: "Verbunden",
    },

    dormant: {
      text: "Ruhemodus – zum Fortsetzen erneut verbinden",
      header: "Ruhemodus",
    },

    error: { text: errorDetail ?? "Verbindungsfehler", header: "Fehler" },
  };

  const info = labels[state];

  let connectTitle: string;
  if (state === "dormant") {
    connectTitle = "Ruhemodus beenden";
  } else {
    connectTitle = ACTIVE_STATES.includes(state)
      ? "Verbindung trennen"
      : "Verbindung herstellen";
  }

  return {
    className: classes.join(" "),
    // Bei Mute + Listening: angepassten Statustext zeigen
    statusText:
      isMuted && state === "listening" ? "Mikrofon stummgeschaltet" : info.text,
    header: info.header,
    connectTitle,
  };
}
