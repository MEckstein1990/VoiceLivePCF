import { describe, expect, it } from "vitest";
import {
  assistantText,
  buildSessionPayload,
  historyItems,
  userText,
} from "../VoiceLiveControl/agent/messages";
import { HISTORY_PREAMBLE_PROMPT } from "../VoiceLiveControl/agent/prompts";
import { INITIAL_CONFIG } from "../VoiceLiveControl/config";

/** Text eines Items, egal ob Nutzer- oder Agenten-Nachricht. */
const textOf = (item: ReturnType<typeof userText>) => item.item.content[0].text;

describe("userText / assistantText", () => {
  it("baut eine Nutzer-Nachricht mit input_text", () => {
    expect(userText("Hallo")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hallo" }],
      },
    });
  });

  it("baut eine Agenten-Nachricht mit text", () => {
    expect(assistantText("Hi")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    });
  });
});

describe("historyItems", () => {
  it("setzt Präambel zuerst und den Hinweis zuletzt", () => {
    const { items, historyCount } = historyItems(
      [
        { role: "ai", text: "Hallo, ich bin Kora." },
        { role: "user", text: "Such die Stadtwerke." },
      ],
      "HINWEIS",
    );

    expect(historyCount).toBe(2);
    expect(items.map((i) => i.item.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(items.map(textOf)).toEqual([
      HISTORY_PREAMBLE_PROMPT,
      "Hallo, ich bin Kora.",
      "Such die Stadtwerke.",
      "HINWEIS",
    ]);
  });

  it("lässt leere Nachrichten weg", () => {
    const { items, historyCount } = historyItems(
      [
        { role: "ai", text: "" },
        { role: "user", text: "   " },
        { role: "user", text: "Ja" },
      ],
      "HINWEIS",
    );

    expect(historyCount).toBe(1);
    expect(items.map(textOf)).toEqual([HISTORY_PREAMBLE_PROMPT, "Ja", "HINWEIS"]);
  });

  it("schickt ohne Verlauf nur den Hinweis, ohne Präambel", () => {
    const { items, historyCount } = historyItems([], "HINWEIS");

    expect(historyCount).toBe(0);
    expect(items.map(textOf)).toEqual(["HINWEIS"]);
  });
});

describe("buildSessionPayload", () => {
  it("übernimmt die Konfiguration in die Session", () => {
    const payload = buildSessionPayload({
      ...INITIAL_CONFIG,
      agentVoice: "de-DE-KatjaNeural",
      agentLanguage: "en",
      voiceSpeed: "1.3",
      silenceDurationMs: 1500,
      vadThreshold: 0.7,
    });

    expect(payload).toEqual({
      type: "realtime",
      output_modalities: ["text", "audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          turn_detection: {
            type: "azure_semantic_vad_multilingual",
            threshold: 0.7,
            prefix_padding_ms: 300,
            silence_duration_ms: 1500,
            languages: ["en"],
            remove_filler_words: false,
            interrupt_response: true,
            auto_truncate: false,
          },
          noise_reduction: { type: "azure_deep_noise_suppression" },
          // USE_LIVE_REFERENCE_AEC ist aus: keine Client-Referenz
          echo_cancellation: { type: "server_echo_cancellation" },
          transcription: { model: "azure-speech", language: "en" },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: { type: "azure-standard", name: "de-DE-KatjaNeural", temperature: 0.8 },
          speed: 1.3,
        },
      },
    });
  });

  it("setzt das Sprechtempo auf 1, wenn der Wert keine Zahl ist", () => {
    const payload = buildSessionPayload({ ...INITIAL_CONFIG, voiceSpeed: "schnell" }) as {
      audio: { output: { speed: number } };
    };
    expect(payload.audio.output.speed).toBe(1);
  });
});
