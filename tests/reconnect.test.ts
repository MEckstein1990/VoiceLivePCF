import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  closeCodeToMessage,
  isRecoverableClose,
} from "../VoiceLiveControl/session/reconnect";

const base = { intentionalClose: false, wasActive: true, code: 1006, attempt: 0 };

describe("isRecoverableClose", () => {
  it("verbindet nach einem unerwarteten Abbruch neu", () => {
    expect(isRecoverableClose(base)).toBe(true);
  });

  it("verbindet nicht neu, wenn das Control selbst getrennt hat", () => {
    expect(isRecoverableClose({ ...base, intentionalClose: true })).toBe(false);
  });

  it("verbindet nicht neu, wenn keine Session lief", () => {
    expect(isRecoverableClose({ ...base, wasActive: false })).toBe(false);
  });

  it("verbindet bei Auth-Fehler (1008) und ungültiger Anfrage (1007) nicht neu", () => {
    expect(isRecoverableClose({ ...base, code: 1008 })).toBe(false);
    expect(isRecoverableClose({ ...base, code: 1007 })).toBe(false);
  });

  it("gibt nach fünf Versuchen auf", () => {
    expect(isRecoverableClose({ ...base, attempt: 4 })).toBe(true);
    expect(isRecoverableClose({ ...base, attempt: 5 })).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("verdoppelt die Wartezeit ab 1,5 s", () => {
    expect([1, 2, 3, 4, 5].map(backoffDelay)).toEqual([1500, 3000, 6000, 12000, 24000]);
  });
});

describe("closeCodeToMessage", () => {
  it("hat feste Texte für bekannte Codes", () => {
    expect(closeCodeToMessage(1006, "")).toBe("Keine Verbindung – Endpoint-URL prüfen");
    expect(closeCodeToMessage(1011, "egal")).toBe("Interner Serverfehler");
  });

  it("nennt bei unbekannten Codes den Grund, falls vorhanden", () => {
    expect(closeCodeToMessage(4000, "Token abgelaufen")).toBe("Fehler 4000: Token abgelaufen");
    expect(closeCodeToMessage(4000, "")).toBe("Verbindung getrennt (Code 4000)");
  });
});
