import { describe, expect, it } from "vitest";
import { StateViewInput, describeState } from "../VoiceLiveControl/ui/statusView";

const base: StateViewInput = {
  state: "idle",
  chatOpen: false,
  isMuted: false,
  dormancyPhase: "none",
  reconnectAttempt: 0,
};

const view = (input: Partial<StateViewInput>) => describeState({ ...base, ...input });

describe("describeState", () => {
  it("idle: nicht verbunden, Button verbindet", () => {
    expect(view({ state: "idle" })).toEqual({
      className: "ai-voice-container state-idle",
      statusText: "Inaktiv",
      header: "Nicht verbunden",
      connectTitle: "Verbindung herstellen",
    });
  });

  it("verbundene Zustände tragen state-connected und state-active", () => {
    for (const state of ["listening", "user-speaking", "ai-thinking", "ai-speaking"] as const) {
      const v = view({ state });
      expect(v.className).toBe(`ai-voice-container state-${state} state-connected state-active`);
      expect(v.header).toBe("Verbunden");
      expect(v.connectTitle).toBe("Verbindung trennen");
    }
  });

  it("Verbindungsaufbau ist aktiv, aber noch nicht verbunden", () => {
    expect(view({ state: "connecting" }).className).toBe(
      "ai-voice-container state-connecting state-active",
    );
    expect(view({ state: "connecting" }).connectTitle).toBe("Verbindung trennen");
  });

  it("zeigt den Reconnect-Zähler", () => {
    const v = view({ state: "reconnecting", reconnectAttempt: 2 });
    expect(v.statusText).toBe("Verbindung wiederherstellen (2/5)…");
    expect(v.header).toBe("Verbindung unterbrochen");
  });

  it("Ruhemodus: eigener Text und Button beendet ihn", () => {
    const v = view({ state: "dormant" });
    expect(v.className).toBe("ai-voice-container state-dormant");
    expect(v.header).toBe("Ruhemodus");
    expect(v.connectTitle).toBe("Ruhemodus beenden");
  });

  it("Fehler: Detailtext oder Standardtext", () => {
    expect(view({ state: "error", errorDetail: "Kein Mikrofon gefunden" }).statusText).toBe(
      "Kein Mikrofon gefunden",
    );
    expect(view({ state: "error" }).statusText).toBe("Verbindungsfehler");
    expect(view({ state: "error" }).connectTitle).toBe("Verbindung herstellen");
  });

  it("stummgeschaltet: eigener Text nur beim Zuhören", () => {
    expect(view({ state: "listening", isMuted: true }).statusText).toBe("Mikrofon stummgeschaltet");
    expect(view({ state: "ai-speaking", isMuted: true }).statusText).toBe("KoRa spricht…");
    expect(view({ state: "listening", isMuted: true }).className).toContain(" muted");
  });

  it("hängt chat-open und dormant-pending an", () => {
    expect(view({ state: "listening", chatOpen: true, dormancyPhase: "pending-dormant" }).className).toBe(
      "ai-voice-container state-listening state-connected state-active chat-open dormant-pending",
    );
    expect(view({ state: "listening", dormancyPhase: "warning" }).className).not.toContain(
      "dormant-pending",
    );
  });
});
