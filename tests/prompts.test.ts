import { describe, expect, it } from "vitest";
import { greetingPrompt } from "../VoiceLiveControl/agent/prompts";

describe("greetingPrompt", () => {
  it("begrüßt persönlich, wenn ein Name bekannt ist", () => {
    expect(greetingPrompt("Alex Savkov")).toBe(
      '[SYSTEM-HINWEIS] Begrüße den Benutzer "Alex Savkov" persönlich mit Vornamen. Stelle dich als Kora vor. Vermeide es "EnBW" zu erwähnen.',
    );
  });

  it("begrüßt allgemein ohne Namen", () => {
    expect(greetingPrompt("")).toBe(
      '[SYSTEM-HINWEIS] Begrüße den Benutzer kurz und freundlich. Stelle dich als Kora vor. Vermeide es "EnBW" zu erwähnen.',
    );
  });
});
