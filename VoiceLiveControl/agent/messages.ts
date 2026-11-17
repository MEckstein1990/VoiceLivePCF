/**
 * Nachrichten an die Voice Live API: Konversations-Items und die
 * Session-Konfiguration. Reine Funktionen – das Senden übernimmt das Control.
 */

import { ControlConfig, USE_LIVE_REFERENCE_AEC } from "../config";
import { ChatMessage } from "../types";
import { HISTORY_PREAMBLE_PROMPT } from "./prompts";

/** Eine Nutzer-Nachricht als Text, z. B. ein [SYSTEM-HINWEIS] an den Agenten. */
export function userText(text: string) {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

/** Eine frühere Aussage des Agenten, die er als seine eigene übernimmt. */
export function assistantText(text: string) {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/**
 * Baut die Items, mit denen der bisherige Gesprächsverlauf in eine frische
 * Session eingespielt wird.
 *
 * Bewusst als einzelne Items mit echten Rollen statt als ein Textblock:
 * Bei role "assistant" übernimmt das Modell diese Aussagen als seine eigenen
 * und macht nahtlos weiter. Derselbe Inhalt als Transkript-Text in einer
 * User-Nachricht wäre für das Modell nur ein Bericht ÜBER ein Gespräch –
 * es antwortet dann mit "laut dem Verlauf haben wir über X gesprochen".
 *
 * REIHENFOLGE IST KRITISCH: Erst der Verlauf, der Hinweistext ZULETZT.
 * Direkt danach folgt response.create, und das Modell antwortet immer auf
 * den jüngsten Turn. Stünde der Hinweis vorne, wäre die letzte Nachricht
 * eine alte Nutzer-Anweisung ("erzähl mir eine Kurzgeschichte") – die das
 * Modell dann prompt ein zweites Mal ausführt, statt sich zurückzumelden.
 *
 * @returns Die Items in Sendereihenfolge und die Anzahl der Verlaufs-Items.
 */
export function historyItems(
  messages: readonly ChatMessage[],
  noticeText: string,
): { items: ReturnType<typeof userText>[]; historyCount: number } {
  const history = messages.filter((m) => m.text.trim());
  const items: ReturnType<typeof userText>[] = [];

  // Rahmt den Verlauf als Erinnerung ein, damit alte Anweisungen darin
  // nicht als frische Aufträge gelesen werden.
  if (history.length > 0) {
    items.push(userText(HISTORY_PREAMBLE_PROMPT));
  }

  for (const msg of history) {
    items.push(msg.role === "user" ? userText(msg.text) : assistantText(msg.text));
  }

  // ZULETZT – siehe Reihenfolge-Hinweis oben. Das ist der Turn, auf den das
  // Modell beim folgenden response.create tatsächlich antwortet.
  items.push(userText(noticeText));

  return { items, historyCount: history.length };
}

/**
 * Session-Konfiguration für das erste `session.update`.
 *
 * Voice-Agent-Endpunkt (kind: voice): Format der GA-Realtime-API mit
 * verschachteltem audio.input / audio.output statt flacher Felder.
 * Turn-Detection-Typ und Echo-Cancellation-Kanäle muss die Agent-Definition
 * schon tragen (azure_semantic_vad_multilingual, bei USE_LIVE_REFERENCE_AEC
 * Client-Referenz mit 2 Kanälen) – die Session kann sie nicht mehr ändern.
 */
export function buildSessionPayload(config: ControlConfig): Record<string, unknown> {
  return {
    type: "realtime",
    // instructions NICHT setzen – wird vom Foundry Agent geladen.
    // Voice, VAD, Noise Suppression etc. sind Session-Properties und
    // müssen immer explizit konfiguriert werden (kommen NICHT vom Agent).
    output_modalities: ["text", "audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },

        turn_detection: {
          type: "azure_semantic_vad_multilingual",
          threshold: config.vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: config.silenceDurationMs,
          languages: [config.agentLanguage],
          remove_filler_words: false,
          interrupt_response: true,
          auto_truncate: false,
        },

        noise_reduction: {
          type: "azure_deep_noise_suppression",
        },

        // Live-Reference AEC: Der Client liefert das tatsächlich abgespielte
        // Signal als zweiten Kanal mit, statt dass der Server sein eigenes
        // gesendetes Audio als Referenz annimmt.
        //
        // Der Standardweg (reference_source "server") setzt voraus, dass der
        // Client sofort abspielt – bei mehr als zwei Sekunden Verzögerung
        // bricht die Entzerrung zusammen. Da die Wiedergabe hier auf einer
        // Zeitleiste geplant wird und der Dienst schneller als Echtzeit
        // streamt, ist genau das der Fall.
        echo_cancellation: {
          type: "server_echo_cancellation",
          ...(USE_LIVE_REFERENCE_AEC
            ? { reference_source: "client", channels: 2 }
            : {}),
        },

        transcription: {
          model: "azure-speech",
          language: config.agentLanguage,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
        voice: {
          type: "azure-standard",
          name: config.agentVoice,
          temperature: 0.8,
        },
        speed: Number(config.voiceSpeed) || 1,
      },
    },
  };
}
