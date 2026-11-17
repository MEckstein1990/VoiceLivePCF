/**
 * Gesprächsmodell: Chat-Verlauf, laufende Transkripte von KI und Nutzer und
 * der Transkript-Text für die Output-Property Transcript.
 *
 * Der Verlauf (`history`) wird beim Reconnect und beim Aufwecken aus dem
 * Ruhemodus in die neue Session eingespielt. Die Anzeige läuft über einen
 * ChatRenderer (im Control: ui/ChatView.ts), damit das Modell ohne Browser
 * testbar bleibt.
 */

import { ChatMessage } from "../types";

/** Was das Gesprächsmodell von der Anzeige braucht. B ist der Bubble-Typ. */
export interface ChatRenderer<B> {
  /** Neue Bubble; eine User-Bubble landet vor `before`, falls diese noch angezeigt wird. Scrollt mit. */
  addBubble(role: "user" | "ai", text: string, before: B | null): B;
  /** Text einer Bubble ersetzen, ohne zu scrollen. */
  setText(bubble: B, text: string): void;
  scrollToBottom(): void;
  clear(): void;
}

export class Conversation<B> {
  private messages: ChatMessage[] = [];
  private transcriptText = "";
  private currentAiTranscript = "";
  private currentUserTranscript = "";
  private lastAiBubble: B | null = null;
  private lastUserBubble: B | null = null;

  constructor(private readonly view: ChatRenderer<B>) {}

  /** Transkript für die Output-Property Transcript ("[User]: …" / "[KI]: …"). */
  get transcript(): string {
    return this.transcriptText;
  }

  /** Bisheriger Verlauf, z. B. zum Einspielen nach einem Reconnect. */
  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  get length(): number {
    return this.messages.length;
  }

  /**
   * Kürzt den Verlauf auf die ersten n Nachrichten. Die Bubbles bleiben
   * sichtbar, sie werden nur nicht mehr als Kontext zurückgespielt.
   */
  truncate(n: number): void {
    this.messages = this.messages.slice(0, n);
  }

  // #region KI

  /** response.created: neue, noch leere KI-Antwort mit Platzhalter-Bubble. */
  beginAiResponse(): void {
    this.currentAiTranscript = "";
    this.lastAiBubble = null;
    this.messages.push({ role: "ai", text: "" });
    this.addBubble("ai", "…");
  }

  /** response.output_audio_transcript.delta */
  appendAiDelta(delta: string): void {
    this.currentAiTranscript += delta;
    const lastAi = this.lastMessage("ai");
    if (lastAi) lastAi.text = this.currentAiTranscript;
    this.updateLastAiBubble();
  }

  /** response.output_audio_transcript.done */
  setAiFinal(transcript: string): void {
    this.currentAiTranscript = transcript;
    const lastAi = this.lastMessage("ai");
    if (lastAi) lastAi.text = transcript;
    this.updateLastAiBubble();
  }

  /**
   * response.done: schreibt die Antwort ins Transkript und schließt die
   * KI-Bubble ab.
   *
   * @returns true, wenn sich das Transkript geändert hat (→ notifyOutputChanged).
   */
  commitAiTurn(): boolean {
    let changed = false;

    if (this.currentAiTranscript) {
      this.transcriptText += `[KI]: ${this.currentAiTranscript}\n`;
      const lastAi = this.lastMessage("ai");
      if (lastAi) lastAi.text = this.currentAiTranscript;
      this.updateLastAiBubble();
      this.currentAiTranscript = "";
      changed = true;
    }

    this.lastAiBubble = null;

    return changed;
  }

  // #endregion

  // #region Nutzer

  /** conversation.item.input_audio_transcription.delta (Streaming, Wort für Wort) */
  appendUserDelta(delta: string): void {
    this.currentUserTranscript += delta;

    if (!this.lastUserBubble) {
      // Erste Delta – neue Bubble erstellen
      this.messages.push({
        role: "user",
        text: this.currentUserTranscript,
      });

      this.addBubble("user", this.currentUserTranscript);

      return;
    }

    this.view.setText(this.lastUserBubble, this.currentUserTranscript);

    this.view.scrollToBottom();
  }

  /** conversation.item.input_audio_transcription.completed (finales Transkript) */
  completeUser(transcript: string): void {
    this.currentUserTranscript = transcript;
    this.transcriptText += `[User]: ${transcript}\n`;

    // Wenn wir schon eine Streaming-Bubble haben, aktualisiere sie
    if (this.lastUserBubble) {
      const lastUser = this.lastMessage("user");

      if (lastUser) lastUser.text = transcript;

      this.view.setText(this.lastUserBubble, transcript);
    } else {
      this.messages.push({ role: "user", text: transcript });

      this.addBubble("user", transcript);
    }

    this.currentUserTranscript = "";
    this.lastUserBubble = null;
  }

  /** Barge-In: Der Nutzer setzt neu an – die nächste Delta startet eine neue Bubble. */
  resetUserStreaming(): void {
    this.currentUserTranscript = "";
    this.lastUserBubble = null;
  }

  // #endregion

  // #region Zurücksetzen

  /** Frischer Start: Transkript und laufende Texte leeren (Verlauf: siehe clear()). */
  resetForNewSession(): void {
    this.transcriptText = "";
    this.currentAiTranscript = "";
    this.currentUserTranscript = "";
  }

  /** Verlauf und Anzeige leeren. */
  clear(): void {
    this.messages = [];
    this.lastAiBubble = null;
    this.lastUserBubble = null;
    this.view.clear();
  }

  // #endregion

  private addBubble(role: "user" | "ai", text: string): void {
    const bubble = this.view.addBubble(role, text, this.lastAiBubble);

    if (role === "ai") {
      this.lastAiBubble = bubble;
    } else {
      this.lastUserBubble = bubble;
    }
  }

  private updateLastAiBubble(): void {
    if (!this.lastAiBubble) return;

    this.view.setText(this.lastAiBubble, this.currentAiTranscript);

    this.view.scrollToBottom();
  }

  private lastMessage(role: "user" | "ai"): ChatMessage | undefined {
    return this.messages
      .slice()
      .reverse()
      .find((m: ChatMessage) => m.role === role);
  }
}
