import { describe, expect, it } from "vitest";
import { getToolDisplayText } from "../VoiceLiveControl/agent/toolStatus";

describe("getToolDisplayText", () => {
  it("nennt bei read_query die Tabelle aus dem FROM", () => {
    const args = JSON.stringify({ querytext: "SELECT name FROM account WHERE name = 'x'" });
    expect(getToolDisplayText("read_query", args)).toBe("Durchsuche Kunden…");
  });

  it("nimmt den technischen Namen, wenn kein Anzeigename hinterlegt ist", () => {
    const args = JSON.stringify({ querytext: "select x from netzebw_other" });
    expect(getToolDisplayText("read_query", args)).toBe("Durchsuche netzebw_other…");
  });

  it("sagt 'Daten', wenn die Abfrage kein FROM hat", () => {
    expect(getToolDisplayText("read_query", JSON.stringify({ querytext: "SELECT 1" }))).toBe(
      "Durchsuche Daten…",
    );
  });

  it("nennt bei create_record die Tabelle", () => {
    const args = JSON.stringify({ tablename: "netzebw_kora_minutes" });
    expect(getToolDisplayText("create_record", args)).toBe("Speichere Protokolle…");
  });

  it("hat feste Texte für update_record und delete_record", () => {
    expect(getToolDisplayText("update_record")).toBe("Aktualisiere Daten…");
    expect(getToolDisplayText("delete_record")).toBe("Lösche Eintrag…");
  });

  it("fällt bei kaputtem JSON auf den Namen des Werkzeugs zurück", () => {
    expect(getToolDisplayText("read_query", "{kein json")).toBe("Durchsuche Daten…");
    expect(getToolDisplayText("create_record", "{kein json")).toBe("Speichere Daten…");
  });

  it("ordnet unbekannte Werkzeuge nach ihrem Präfix ein", () => {
    expect(getToolDisplayText("search")).toBe("Durchsuche Daten…");
    expect(getToolDisplayText("list_tables")).toBe("Durchsuche Daten…");
    expect(getToolDisplayText("save_note")).toBe("Speichere Daten…");
    expect(getToolDisplayText("whoami")).toBe("Verarbeite Anfrage…");
  });
});
