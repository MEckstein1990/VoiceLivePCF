/**
 * Reconnect-Regeln: wann eine geschlossene Verbindung automatisch neu
 * aufgebaut wird, wie lange dazwischen gewartet wird und welcher Text bei
 * einem Abbruch erscheint.
 */

import { MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS } from "../config";

export interface CloseInfo {
  /** Das Control hat die Verbindung selbst geschlossen (Trennen, Ruhemodus). */
  intentionalClose: boolean;
  /** Die Session lief, als die Verbindung abbrach. */
  wasActive: boolean;
  /** WebSocket-Close-Code. */
  code: number;
  /** Bisherige Reconnect-Versuche in Folge. */
  attempt: number;
}

/**
 * Reconnect bei unerwartetem Verbindungsabbruch (Netzwerkfehler o.ä.).
 * Der Ausnahmefall – die Session läuft sonst unbegrenzt, das Backend
 * hält sie offen.
 */
export function isRecoverableClose(info: CloseInfo): boolean {
  return (
    !info.intentionalClose &&
    info.wasActive &&
    info.code !== 1008 && // Policy violation (Auth-Fehler)
    info.code !== 1007 && // Invalid payload / Agent not found
    info.attempt < MAX_RECONNECT_ATTEMPTS
  );
}

/** Exponentieller Backoff: 1,5 s, 3 s, 6 s, … für Versuch 1, 2, 3, … */
export function backoffDelay(attempt: number): number {
  return RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

export function closeCodeToMessage(code: number, reason: string): string {
  const map: Record<number, string> = {
    1006: "Keine Verbindung – Endpoint-URL prüfen",
    1007: "Agent nicht gefunden oder fehlerhafte Anfrage",
    1008: "Richtlinienverstoß – API-Key oder Berechtigungen prüfen",
    1011: "Interner Serverfehler",
  };

  return (
    map[code] ??
    (reason
      ? `Fehler ${code}: ${reason}`
      : `Verbindung getrennt (Code ${code})`)
  );
}
