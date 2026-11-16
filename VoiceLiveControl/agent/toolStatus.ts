/**
 * Statustexte für MCP-Tool-Aufrufe ("Durchsuche Kunden…" statt "read_query").
 */

/** Benutzerfreundliche Anzeigenamen für Dataverse-Tabellen */
export const TABLE_DISPLAY_NAMES: Record<string, string> = {
  account: "Kunden",
  contact: "Kontakte",
  netzebw_kora_minutes: "Protokolle",
  opportunity: "Verkaufschancen",
  incident: "Anfragen",
  task: "Aufgaben",
  appointment: "Termine",
};

/** Erzeugt benutzerfreundlichen Status-Text für einen MCP-Tool-Aufruf */
export function getToolDisplayText(toolName: string, args?: string): string {
  try {
    const parsed = args ? JSON.parse(args) : null;

    if (toolName === "read_query" && parsed?.querytext) {
      const match = parsed.querytext.match(/FROM\s+(\w+)/i);
      const table = match?.[1];
      const displayName = table
        ? TABLE_DISPLAY_NAMES[table] || table
        : "Daten";
      return `Durchsuche ${displayName}…`;
    }

    if (toolName === "create_record" && parsed?.tablename) {
      const displayName =
        TABLE_DISPLAY_NAMES[parsed.tablename] || parsed.tablename;
      return `Speichere ${displayName}…`;
    }

    if (toolName === "update_record") {
      return "Aktualisiere Daten…";
    }

    if (toolName === "delete_record") {
      return "Lösche Eintrag…";
    }
  } catch {
    // JSON-Parse fehlgeschlagen – Fallback
  }

  if (toolName.startsWith("read") || toolName.startsWith("search") || toolName.startsWith("list")) {
    return "Durchsuche Daten…";
  }
  if (toolName.startsWith("create") || toolName.startsWith("save") || toolName.startsWith("write")) {
    return "Speichere Daten…";
  }
  return "Verarbeite Anfrage…";
}
