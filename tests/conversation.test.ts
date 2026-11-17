import { beforeEach, describe, expect, it } from "vitest";
import { ChatRenderer, Conversation } from "../VoiceLiveControl/conversation/Conversation";

/** Bubble im Fake-Renderer: Rolle und angezeigter Text. */
interface FakeBubble {
  role: "user" | "ai";
  text: string;
}

/** Bildet das Chat-Panel als einfache Liste nach, inkl. "User-Bubble vor laufender KI-Bubble". */
class FakeChat implements ChatRenderer<FakeBubble> {
  bubbles: FakeBubble[] = [];
  scrolls = 0;
  clears = 0;

  addBubble(role: "user" | "ai", text: string, before: FakeBubble | null): FakeBubble {
    const bubble = { role, text };
    const idx = before ? this.bubbles.indexOf(before) : -1;
    if (role === "user" && idx >= 0) {
      this.bubbles.splice(idx, 0, bubble);
    } else {
      this.bubbles.push(bubble);
    }
    this.scrolls++;
    return bubble;
  }

  setText(bubble: FakeBubble, text: string): void {
    bubble.text = text;
  }

  scrollToBottom(): void {
    this.scrolls++;
  }

  clear(): void {
    this.bubbles = [];
    this.clears++;
  }

  get shown() {
    return this.bubbles.map((b) => `${b.role}:${b.text}`);
  }
}

let chat: FakeChat;
let conv: Conversation<FakeBubble>;

beforeEach(() => {
  chat = new FakeChat();
  conv = new Conversation(chat);
});

describe("KI-Antwort", () => {
  it("beginnt mit Platzhalter und streamt den Text", () => {
    conv.beginAiResponse();
    expect(chat.shown).toEqual(["ai:…"]);
    expect(conv.history).toEqual([{ role: "ai", text: "" }]);

    conv.appendAiDelta("Hallo");
    conv.appendAiDelta(" Alex");
    expect(chat.shown).toEqual(["ai:Hallo Alex"]);
    expect(conv.history).toEqual([{ role: "ai", text: "Hallo Alex" }]);
  });

  it("übernimmt das finale Transkript", () => {
    conv.beginAiResponse();
    conv.appendAiDelta("Halo");
    conv.setAiFinal("Hallo");
    expect(chat.shown).toEqual(["ai:Hallo"]);
    expect(conv.history[0].text).toBe("Hallo");
  });

  it("schreibt beim Abschluss ins Transkript und meldet die Änderung", () => {
    conv.beginAiResponse();
    conv.appendAiDelta("Hallo");
    expect(conv.commitAiTurn()).toBe(true);
    expect(conv.transcript).toBe("[KI]: Hallo\n");
  });

  it("meldet keine Änderung bei leerer Antwort", () => {
    conv.beginAiResponse();
    expect(conv.commitAiTurn()).toBe(false);
    expect(conv.transcript).toBe("");
  });

  it("schließt die Bubble ab: spätere Deltas ändern sie nicht mehr", () => {
    conv.beginAiResponse();
    conv.appendAiDelta("Erste");
    conv.commitAiTurn();
    conv.appendAiDelta("Nachzügler");
    expect(chat.shown).toEqual(["ai:Erste"]);
  });
});

describe("Nutzer", () => {
  it("streamt in eine eigene Bubble", () => {
    conv.appendUserDelta("Such");
    conv.appendUserDelta(" die Stadtwerke");
    expect(chat.shown).toEqual(["user:Such die Stadtwerke"]);
    // Der Verlauf hält beim Streaming den Text der ersten Delta, erst completeUser setzt ihn final.
    expect(conv.history).toEqual([{ role: "user", text: "Such" }]);
  });

  it("setzt mit dem finalen Transkript Bubble, Verlauf und Transkript", () => {
    conv.appendUserDelta("Such die");
    conv.completeUser("Such die Stadtwerke.");
    expect(chat.shown).toEqual(["user:Such die Stadtwerke."]);
    expect(conv.history).toEqual([{ role: "user", text: "Such die Stadtwerke." }]);
    expect(conv.transcript).toBe("[User]: Such die Stadtwerke.\n");
  });

  it("legt ohne Streaming eine neue Bubble an", () => {
    conv.completeUser("Ja.");
    expect(chat.shown).toEqual(["user:Ja."]);
    expect(conv.history).toEqual([{ role: "user", text: "Ja." }]);
  });

  it("die nächste Äußerung bekommt eine neue Bubble", () => {
    conv.completeUser("Eins.");
    conv.appendUserDelta("Zwei");
    expect(chat.shown).toEqual(["user:Eins.", "user:Zwei"]);
  });

  it("landet vor der KI-Antwort, wenn diese schon läuft", () => {
    conv.beginAiResponse();
    conv.appendUserDelta("Frage");
    expect(chat.shown).toEqual(["user:Frage", "ai:…"]);
  });

  it("Barge-In: die nächste Delta startet eine neue Bubble", () => {
    conv.appendUserDelta("Abgebrochen");
    conv.resetUserStreaming();
    conv.appendUserDelta("Neu");
    expect(chat.shown).toEqual(["user:Abgebrochen", "user:Neu"]);
  });
});

describe("Verlauf", () => {
  it("baut ein ganzes Gespräch in der richtigen Reihenfolge auf", () => {
    conv.beginAiResponse();
    conv.appendAiDelta("Hallo, ich bin Kora.");
    conv.commitAiTurn();
    conv.completeUser("Such die Stadtwerke.");
    conv.beginAiResponse();
    conv.setAiFinal("Gefunden.");
    conv.commitAiTurn();

    expect(conv.history).toEqual([
      { role: "ai", text: "Hallo, ich bin Kora." },
      { role: "user", text: "Such die Stadtwerke." },
      { role: "ai", text: "Gefunden." },
    ]);
    expect(conv.transcript).toBe(
      "[KI]: Hallo, ich bin Kora.\n[User]: Such die Stadtwerke.\n[KI]: Gefunden.\n",
    );
  });

  it("kürzt den Verlauf, die Anzeige bleibt", () => {
    conv.completeUser("Eins.");
    conv.completeUser("Zwei.");
    conv.truncate(1);
    expect(conv.length).toBe(1);
    expect(conv.history).toEqual([{ role: "user", text: "Eins." }]);
    expect(chat.shown).toEqual(["user:Eins.", "user:Zwei."]);
  });

  it("resetForNewSession leert Transkript, clear den Verlauf und die Anzeige", () => {
    conv.completeUser("Eins.");
    conv.resetForNewSession();
    expect(conv.transcript).toBe("");
    expect(conv.length).toBe(1);

    conv.clear();
    expect(conv.length).toBe(0);
    expect(chat.clears).toBe(1);
    expect(chat.shown).toEqual([]);
  });
});
