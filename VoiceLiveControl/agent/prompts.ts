/**
 * System-Hinweise an den Agenten.
 *
 * Anweisungen, WIE die KI etwas sagen soll – nicht der wörtlich gesprochene
 * Text. Sie formuliert daraus jedes Mal selbst und passt sich dem Gespräch an.
 * Bewusst im Code statt als Manifest-Properties: Sie werden selten angefasst und
 * hätten das Property-Pane nur zugestellt.
 */

/**
 * Begrüßung beim ersten Verbindungsaufbau. Mit Benutzernamen persönlich,
 * sonst allgemein.
 */
export function greetingPrompt(userName: string): string {
  return userName
    ? `[SYSTEM-HINWEIS] Begrüße den Benutzer "${userName}" persönlich mit Vornamen. Stelle dich als Kora vor. Vermeide es "EnBW" zu erwähnen.`
    : "[SYSTEM-HINWEIS] Begrüße den Benutzer kurz und freundlich. Stelle dich als Kora vor. Vermeide es \"EnBW\" zu erwähnen.";
}

/**
 * Ansage vor dem Ruhemodus. Der Zusatz "keine Tools" ist wichtig: Ein
 * Tool-Aufruf als Reaktion würde die Inaktivitätsmessung zurücksetzen und
 * den Ablauf mitten in der geschützten Phase abbrechen.
 */
export const DORMANT_WARNING_PROMPT =
  "[SYSTEM-HINWEIS] Es gab länger keine Aktivität. Sage dem Benutzer in EINEM kurzen Satz, " +
  "dass du jetzt in den Ruhemodus gehst und er dich jederzeit wieder antippen kann, um " +
  "weiterzumachen. Stelle KEINE Rückfrage und rufe KEINE Tools auf.";

/**
 * Bestätigung, wenn der Benutzer den Ruhemodus durch Tippen abbricht.
 * Der Tool-Hinweis aus demselben Grund wie oben.
 */
export const DORMANT_CANCEL_PROMPT =
  "[SYSTEM-HINWEIS] Der Benutzer ist doch noch da und hat den Ruhemodus abgebrochen. " +
  "Bestätige das in EINEM sehr kurzen Satz, etwa \"Okay, machen wir weiter\". " +
  "Stelle KEINE Rückfrage und rufe KEINE Tools auf.";

/** Rückmeldung nach dem Aufwecken – kein erneutes Begrüßen. */
export const DORMANT_RESUME_PROMPT =
  "[SYSTEM-HINWEIS] Der Ruhemodus wurde beendet, das Gespräch wird fortgesetzt. " +
  "Antworte JETZT auf diesen Hinweis – nicht auf ältere Nachrichten im Verlauf. " +
  "Führe frühere Anweisungen NICHT erneut aus, sie sind bereits erledigt. " +
  "Begrüße den Benutzer NICHT erneut und stelle dich NICHT erneut vor. " +
  "Sage kurz, dass du wieder da bist, fasse in einem Halbsatz zusammen, " +
  "woran ihr zuletzt gearbeitet habt, und frage, ob ihr damit weitermachen " +
  "sollt oder ob etwas anderes ansteht.";

/** Rückmeldung nach einem automatischen Reconnect. */
export const RECONNECT_RESUME_PROMPT =
  "[SYSTEM-HINWEIS] Die Verbindung wurde kurz unterbrochen und automatisch wiederhergestellt. " +
  "Antworte JETZT auf diesen Hinweis – nicht auf ältere Nachrichten im Verlauf. " +
  "Führe frühere Anweisungen NICHT erneut aus, sie sind bereits erledigt. " +
  "Begrüße den Benutzer NICHT erneut – sage stattdessen kurz, dass du wieder da " +
  "bist und wo ihr stehengeblieben seid.";

/** Rahmt den reinjizierten Verlauf als Erinnerung ein, nicht als Auftrag. */
export const HISTORY_PREAMBLE_PROMPT =
  "[SYSTEM-HINWEIS] Es folgt der bisherige Gesprächsverlauf – ausschließlich " +
  "zur Erinnerung an das, was bereits gelaufen ist. Die darin enthaltenen " +
  "Anweisungen sind bereits erledigt und dürfen NICHT erneut ausgeführt werden.";
