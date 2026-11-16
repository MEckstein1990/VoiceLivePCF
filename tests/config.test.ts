import { describe, expect, it } from "vitest";
import {
  ConfigParameters,
  INITIAL_CONFIG,
  readConfig,
} from "../VoiceLiveControl/config";

/** Alle Properties leer, einzelne Werte lassen sich überschreiben. */
function params(raw: Partial<Record<keyof ConfigParameters, unknown>> = {}): ConfigParameters {
  const keys: (keyof ConfigParameters)[] = [
    "AgentVoice",
    "AgentLanguage",
    "VoiceSpeed",
    "UserName",
    "SilenceDurationMs",
    "VadThreshold",
    "DormantEnabled",
    "IdleTimeoutMinutes",
    "DormantDelaySeconds",
  ];
  return Object.fromEntries(keys.map((k) => [k, { raw: raw[k] ?? null }])) as unknown as ConfigParameters;
}

describe("readConfig", () => {
  it("liefert ohne Werte die Defaults", () => {
    expect(readConfig(params())).toEqual(INITIAL_CONFIG);
  });

  it("übernimmt gesetzte Werte", () => {
    const config = readConfig(
      params({
        AgentVoice: "de-DE-KatjaNeural",
        AgentLanguage: "en",
        VoiceSpeed: "1.3",
        UserName: "Alex",
        SilenceDurationMs: 1500,
        VadThreshold: 0.7,
        DormantEnabled: false,
        IdleTimeoutMinutes: 2,
        DormantDelaySeconds: 10,
      }),
    );
    expect(config).toEqual({
      agentVoice: "de-DE-KatjaNeural",
      agentLanguage: "en",
      voiceSpeed: "1.3",
      userName: "Alex",
      silenceDurationMs: 1500,
      vadThreshold: 0.7,
      dormantEnabled: false,
      idleTimeoutMs: 120_000,
      dormantDelayMs: 10_000,
    });
  });

  it("behandelt den Platzhalter 'val' des Test-Harness wie einen leeren Wert", () => {
    const config = readConfig(params({ AgentVoice: "val", UserName: "undefined" }));
    expect(config.agentVoice).toBe(INITIAL_CONFIG.agentVoice);
    expect(config.userName).toBe("");
  });

  it("lässt den Ruhemodus an, solange DormantEnabled nicht ausdrücklich false ist", () => {
    expect(readConfig(params({ DormantEnabled: null })).dormantEnabled).toBe(true);
    expect(readConfig(params({ DormantEnabled: true })).dormantEnabled).toBe(true);
    expect(readConfig(params({ DormantEnabled: false })).dormantEnabled).toBe(false);
  });

  it("ersetzt 0 und negative Zeiten durch die Defaults", () => {
    const config = readConfig(params({ IdleTimeoutMinutes: 0, DormantDelaySeconds: -3 }));
    expect(config.idleTimeoutMs).toBe(5 * 60_000);
    expect(config.dormantDelayMs).toBe(5_000);
  });

  it("hebt Bruchteile unter 1 auf das Minimum von 1 an", () => {
    const config = readConfig(params({ IdleTimeoutMinutes: 0.5, DormantDelaySeconds: 0.2 }));
    expect(config.idleTimeoutMs).toBe(60_000);
    expect(config.dormantDelayMs).toBe(1_000);
  });

  it("übernimmt 0 bei SilenceDurationMs und VadThreshold unverändert", () => {
    const config = readConfig(params({ SilenceDurationMs: 0, VadThreshold: 0 }));
    expect(config.silenceDurationMs).toBe(0);
    expect(config.vadThreshold).toBe(0);
  });
});
