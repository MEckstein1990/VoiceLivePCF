import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DormancyController,
  DormancyHost,
  countdownText,
} from "../VoiceLiveControl/dormancy/DormancyController";
import { DORMANT_CANCEL_PROMPT, DORMANT_WARNING_PROMPT } from "../VoiceLiveControl/agent/prompts";

const MIN = 60_000;

/** Fake-Control: zeichnet alle Aufrufe auf. */
function createHost() {
  const state = {
    config: { dormantEnabled: true, idleTimeoutMs: 1 * MIN, dormantDelayMs: 5_000 },
    canAnnounce: true,
    conversationLength: 4,
    remainingPlaybackMs: 0,
    sent: [] as unknown[],
    logs: [] as string[],
    statusTexts: [] as string[],
    pendingClass: false,
    listeningCalls: 0,
    dormantCalls: 0,
  };
  const host: DormancyHost = {
    log: (m) => state.logs.push(m),
    config: () => state.config,
    canAnnounce: () => state.canAnnounce,
    conversationLength: () => state.conversationLength,
    remainingPlaybackMs: () => state.remainingPlaybackMs,
    sendJson: (o) => state.sent.push(o),
    setListening: () => state.listeningCalls++,
    showStatusText: (t) => state.statusTexts.push(t),
    setPendingClass: (on) => (state.pendingClass = on),
    enterDormant: () => state.dormantCalls++,
  };
  return { host, state };
}

/** Texte der gesendeten Nutzer-Nachrichten bzw. Typen der übrigen Nachrichten. */
const sentSummary = (sent: unknown[]) =>
  sent.map((o) => {
    const m = o as { type: string; item?: { content: { text: string }[] } };
    return m.item ? m.item.content[0].text : m.type;
  });

let h: ReturnType<typeof createHost>;
let d: DormancyController;

/** Startet die Prüfung wie onopen: Frist ab jetzt. */
function startSession() {
  d.resetIdleTimer();
  d.markConversationActivity();
  d.startIdleWatch();
}

/** Spult bis zur Ansage vor (Frist 1 min, Tick alle 10 s). */
async function runUntilWarning() {
  await vi.advanceTimersByTimeAsync(1 * MIN);
  expect(d.phase).toBe("warning");
}

beforeEach(() => {
  vi.useFakeTimers();
  h = createHost();
  d = new DormancyController(h.host);
});

afterEach(() => {
  d.stopIdleWatch();
  d.abort();
  vi.useRealTimers();
});

describe("countdownText", () => {
  it("unterscheidet Einzahl und Mehrzahl", () => {
    expect(countdownText(3)).toBe("Ruhemodus in 3 Sekunden…");
    expect(countdownText(1)).toBe("Ruhemodus in 1 Sekunde…");
  });
});

describe("Ansage", () => {
  it("kommt erst nach Ablauf der Frist", async () => {
    startSession();

    await vi.advanceTimersByTimeAsync(50_000);
    expect(d.phase).toBe("none");
    expect(h.state.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.phase).toBe("warning");
    expect(d.isProtectedResponse).toBe(true);
    expect(sentSummary(h.state.sent)).toEqual([DORMANT_WARNING_PROMPT, "response.create"]);
    expect(d.lengthBeforeWarning).toBe(4);
  });

  it("kommt nicht, wenn der Ruhemodus aus ist oder das Control nicht bereit ist", async () => {
    h.state.config.dormantEnabled = false;
    startSession();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(d.phase).toBe("none");

    h.state.config.dormantEnabled = true;
    h.state.canAnnounce = false;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(d.phase).toBe("none");
    expect(h.state.sent).toEqual([]);
  });

  it("ein Tool-Aufruf verlängert die Frist", async () => {
    startSession();
    await vi.advanceTimersByTimeAsync(50_000);
    d.noteToolActivity();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(d.phase).toBe("none");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.phase).toBe("warning");
  });

  it("ein Tool-Aufruf während der Ansage bricht sie nicht ab", async () => {
    startSession();
    await runUntilWarning();
    d.noteToolActivity();
    expect(d.phase).toBe("warning");
  });

  it("Quiet-Gate: schiebt bei laufendem Gespräch auf und erzwingt nach 60 s", async () => {
    startSession();
    await vi.advanceTimersByTimeAsync(55_000);

    // Gespräch läuft weiter: alle 2 s Aktivität
    const chatter = setInterval(() => d.markConversationActivity(), 2_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.phase).toBe("none");
    expect(h.state.logs).toContain("Ruhemodus-Ansage aufgeschoben – Gespräch noch aktiv");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.phase).toBe("warning");
    expect(h.state.logs).toContain("Ruhemodus-Ansage wird trotz Aktivität erzwungen");

    clearInterval(chatter);
  });
});

describe("Ende der Ansage und Countdown", () => {
  it("mit Audio: wartet auf das Ende der Wiedergabe, zählt herunter und trennt", async () => {
    startSession();
    await runUntilWarning();

    expect(d.onResponseDone(3)).toBe(true);
    expect(h.state.logs).toContain("Ruhemodus-Ansage: 3 Audio-Chunks laufen noch");
    expect(d.phase).toBe("warning");

    d.onPlaybackDrained();
    expect(d.phase).toBe("pending-dormant");
    expect(h.state.pendingClass).toBe(true);
    expect(h.state.statusTexts).toEqual(["Ruhemodus in 5 Sekunden…"]);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.state.statusTexts.at(-1)).toBe("Ruhemodus in 1 Sekunde…");
    expect(h.state.dormantCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.state.dormantCalls).toBe(1);
  });

  it("ohne Audio: Countdown startet sofort", async () => {
    startSession();
    await runUntilWarning();
    expect(d.onResponseDone(0)).toBe(true);
    expect(d.phase).toBe("pending-dormant");
  });

  it("andere Antworten übernimmt der Ruhemodus nicht", () => {
    expect(d.onResponseDone(2)).toBe(false);
  });

  it("onPlaybackDrained ohne Ansage tut nichts", () => {
    d.onPlaybackDrained();
    expect(d.phase).toBe("none");
  });
});

describe("Abbruch durch Tippen", () => {
  const anywhere = { closest: () => null } as unknown as Element;
  const connectButton = { closest: () => ({}) } as unknown as Element;

  it("im Countdown: bricht ab, bestätigt und setzt die Frist neu", async () => {
    startSession();
    await runUntilWarning();
    d.onResponseDone(0);
    h.state.sent = [];

    d.onPointerDown(anywhere);

    expect(d.phase).toBe("none");
    expect(h.state.pendingClass).toBe(false);
    expect(h.state.listeningCalls).toBe(1);
    expect(sentSummary(h.state.sent)).toEqual([DORMANT_CANCEL_PROMPT, "response.create"]);

    // Frist neu: frühestens nach einer weiteren Minute
    await vi.advanceTimersByTimeAsync(50_000);
    expect(d.phase).toBe("none");
    expect(h.state.dormantCalls).toBe(0);
  });

  it("während der Ansage: nur vorgemerkt, danach kein Countdown", async () => {
    startSession();
    await runUntilWarning();

    d.onPointerDown(anywhere);
    expect(d.phase).toBe("warning");
    expect(h.state.logs).toContain("Abbruch während der Ansage vorgemerkt");

    d.onResponseDone(0);
    expect(d.phase).toBe("none");
    expect(h.state.statusTexts).toEqual([]);
    expect(h.state.listeningCalls).toBe(1);
  });

  it("der Verbinden-Button bricht nicht ab", async () => {
    startSession();
    await runUntilWarning();
    d.onResponseDone(0);

    d.onPointerDown(connectButton);
    expect(d.phase).toBe("pending-dormant");
  });

  it("außerhalb des Ablaufs ohne Wirkung", () => {
    d.onPointerDown(anywhere);
    expect(h.state.listeningCalls).toBe(0);
  });
});

describe("Sicherungen", () => {
  it("Watchdog: ohne Antwort nach 60 s in den Ruhemodus", async () => {
    startSession();
    await runUntilWarning();
    d.stopIdleWatch();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.state.dormantCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.dormantCalls).toBe(1);
  });

  it("Backup-Timer: Restlaufzeit + Nachlaufzeit + 2 s, falls onended ausbleibt", async () => {
    startSession();
    await runUntilWarning();
    d.stopIdleWatch();
    h.state.remainingPlaybackMs = 3_000;

    d.onResponseDone(2);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.state.dormantCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.dormantCalls).toBe(1);
    expect(h.state.logs).toContain("Playback-Ende blieb aus – gehe trotzdem in den Ruhemodus");
  });
});

describe("Abbruch, Ruhemodus, Aufwecken", () => {
  it("abort löscht alle Timer und die Phase", async () => {
    startSession();
    await runUntilWarning();
    d.stopIdleWatch();

    d.abort();
    expect(d.phase).toBe("none");
    expect(d.lengthBeforeWarning).toBeNull();
    expect(h.state.logs).toContain("Ruhemodus-Ablauf abgebrochen");

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.state.dormantCalls).toBe(0);
  });

  it("abort lässt den Ruhezustand 'dormant' stehen, reset nicht", () => {
    d.markDormant();
    d.abort();
    expect(d.phase).toBe("dormant");
    expect(d.isProtectedResponse).toBe(false);

    d.reset();
    expect(d.phase).toBe("none");
  });

  it("abort lässt die Frist stehen: nach Reconnect kommt die Ansage beim nächsten Tick", async () => {
    startSession();
    await runUntilWarning();
    d.abort(); // Verbindungsabbruch
    expect(d.phase).toBe("none");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.phase).toBe("warning");
  });

  it("prepareWake verlässt den Ruhemodus und startet die Frist neu", async () => {
    startSession();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    d.stopIdleWatch();
    d.markDormant();

    d.prepareWake();
    expect(d.phase).toBe("none");

    d.startIdleWatch();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(d.phase).toBe("none");
  });
});
