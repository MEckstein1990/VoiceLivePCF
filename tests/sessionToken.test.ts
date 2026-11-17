import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionTokenRequester,
  parseSessionProperties,
} from "../VoiceLiveControl/session/sessionToken";

const VALID = JSON.stringify({ access_token: "abc", endpoint: "wss://host/api/voice-live/ws" });

describe("parseSessionProperties", () => {
  it("liest Token und Endpunkt aus gültigem JSON", () => {
    expect(parseSessionProperties(VALID)).toEqual({
      accessToken: "abc",
      endpoint: "wss://host/api/voice-live/ws",
    });
  });

  it("gibt die Meldung der App bei 'error:…' weiter, auch mit Doppelpunkten", () => {
    expect(() => parseSessionProperties("error:123456:Connector: nicht freigegeben")).toThrow(
      "Connector: nicht freigegeben",
    );
  });

  it("hat eine Standardmeldung, wenn die App keine Meldung mitschickt", () => {
    expect(() => parseSessionProperties("error:123456:")).toThrow(
      "Session-Token konnte nicht abgerufen werden",
    );
  });

  it("lehnt kaputtes JSON, fehlendes Token und Nicht-wss-Endpunkte ab", () => {
    const expected = "SessionProperties enthält kein gültiges JSON";
    expect(() => parseSessionProperties("{kein json")).toThrow(expected);
    expect(() => parseSessionProperties(JSON.stringify({ endpoint: "wss://x" }))).toThrow(expected);
    expect(() =>
      parseSessionProperties(JSON.stringify({ access_token: "abc", endpoint: "https://x" })),
    ).toThrow(expected);
  });
});

describe("SessionTokenRequester", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("löst OnTokenNeeded aus und liefert die Antwort aus SessionProperties", async () => {
    const requester = new SessionTokenRequester();
    const raise = vi.fn(() => requester.offer(VALID));

    await expect(requester.request(raise)).resolves.toEqual({
      accessToken: "abc",
      endpoint: "wss://host/api/voice-live/ws",
    });
    expect(raise).toHaveBeenCalledOnce();
  });

  it("bricht sofort ab, wenn das Event fehlt", async () => {
    await expect(new SessionTokenRequester().request(undefined)).rejects.toThrow(
      "Das Event OnTokenNeeded gibt es nur in Canvas-Apps und Custom Pages",
    );
  });

  it("bricht nach 20 Sekunden ohne Antwort ab", async () => {
    const promise = new SessionTokenRequester().request(() => undefined);
    const assertion = expect(promise).rejects.toThrow("Die App hat kein Session-Token geliefert");

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("reagiert nur auf geänderte Werte", async () => {
    const requester = new SessionTokenRequester();
    requester.offer(VALID); // ohne offene Anforderung nur gemerkt

    // Derselbe Wert beantwortet die neue Anforderung nicht …
    const promise = requester.request(() => requester.offer(VALID));
    let settled = false;
    void promise.finally(() => (settled = true)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    // … ein neuer Wert schon.
    requester.offer(JSON.stringify({ access_token: "neu", endpoint: "wss://host" }));
    await expect(promise).resolves.toEqual({ accessToken: "neu", endpoint: "wss://host" });
  });

  it("ignoriert leere Werte", async () => {
    const requester = new SessionTokenRequester();
    const promise = requester.request(() => requester.offer(""));
    const assertion = expect(promise).rejects.toThrow("Die App hat kein Session-Token geliefert");

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("gibt Fehlermeldungen der App als Ablehnung weiter", async () => {
    const requester = new SessionTokenRequester();
    await expect(
      requester.request(() => requester.offer("error:1:Connector noch nicht freigegeben")),
    ).rejects.toThrow("Connector noch nicht freigegeben");
  });
});
