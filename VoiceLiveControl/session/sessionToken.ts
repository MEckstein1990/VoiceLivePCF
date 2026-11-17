/**
 * Session-Token aus der App.
 *
 * Das Control hat kein Entra-Token. Die App ruft den Custom Connector „KoRa VoiceLive“ (er meldet den Nutzer an
 * und schickt dessen Token an POST /api/voice-live/token) und liefert dessen Antwort als JSON über die
 * Property SessionProperties (access_token und endpoint, den WebSocket-Endpunkt des Backends).
 * Braucht das Control ein neues Token, löst es das Event OnTokenNeeded aus.
 * Schlägt der Aufruf in der App fehl, liefert sie statt des JSON "error:<eindeutiger Zusatz>:<Meldung>".
 * Der Zusatz (z. B. die Uhrzeit) sorgt dafür, dass sich der Wert bei jedem Fehler ändert, denn Power Apps
 * meldet dem Control nur Änderungen.
 */

import { TOKEN_WAIT_MS } from "../config";

export interface SessionToken {
  accessToken: string;
  endpoint: string;
}

/**
 * Wertet den Inhalt von SessionProperties aus.
 *
 * @throws Error mit der Meldung der App (bei "error:…") oder einer Beschreibung,
 *         was am JSON fehlt.
 */
export function parseSessionProperties(value: string): SessionToken {
  if (value.startsWith("error:")) {
    const message = value.split(":").slice(2).join(":").trim();
    throw new Error(message || "Session-Token konnte nicht abgerufen werden");
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
    throw new Error(
      "SessionProperties enthält kein gültiges JSON mit access_token und endpoint (wss://…)",
    );
  }
  return { accessToken, endpoint };
}

/**
 * Fordert bei der App ein Session-Token an und wartet auf die Antwort über
 * SessionProperties.
 */
export class SessionTokenRequester {
  /** Zuletzt gesehener Wert von SessionProperties. */
  private lastValue = "";
  private waiter: ((value: string) => void) | null = null;

  /**
   * Löst das Event OnTokenNeeded aus und wartet auf SessionProperties. Bei einem Fehler liefert die App
   * "error:<eindeutiger Zusatz>:<Meldung>", das Control bricht dann sofort mit dieser Meldung ab.
   * Die Wartezeit ist nur die Reserve für eine App, die das Event nicht beantwortet.
   *
   * @param raiseTokenNeeded Das Event OnTokenNeeded aus context.events (fehlt außerhalb von Canvas-Apps).
   */
  request(raiseTokenNeeded: (() => void) | undefined): Promise<SessionToken> {
    return new Promise((resolve, reject) => {
      if (!raiseTokenNeeded) {
        reject(
          new Error(
            "Das Event OnTokenNeeded gibt es nur in Canvas-Apps und Custom Pages",
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.waiter = null;
        reject(
          new Error(
            "Die App hat kein Session-Token geliefert (ist OnTokenNeeded belegt?)",
          ),
        );
      }, TOKEN_WAIT_MS);

      this.waiter = (value: string) => {
        clearTimeout(timer);
        try {
          resolve(parseSessionProperties(value));
        } catch (err) {
          reject(err);
        }
      };

      raiseTokenNeeded();
    });
  }

  /**
   * Neuer Wert von SessionProperties aus updateView. Ein geänderter Wert
   * beantwortet die offene Anforderung, ohne offene Anforderung wird er nur gemerkt.
   */
  offer(value: string): void {
    if (!value || value === this.lastValue) return;

    this.lastValue = value;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(value);
  }
}
