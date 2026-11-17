/**
 * Chat-Panel – WhatsApp-Style Transkript-Anzeige. Nur DOM-Arbeit; welche
 * Nachrichten es gibt, verwaltet conversation/Conversation.ts.
 */

import { ChatRenderer } from "../conversation/Conversation";

/**
 * Abstand zum Ende, ab dem der Nutzer noch als "liest mit" gilt.
 *
 * Misst bewusst NICHT das Wachstum des Inhalts – genau daran ist die
 * frühere Heuristik gescheitert, als die Bubbles größer wurden als ihr
 * Schwellwert. Hier geht es nur um die Ruheposition des Nutzers, der Wert
 * ist damit unabhängig von Schriftgröße und Bubble-Höhe.
 */
const CHAT_BOTTOM_THRESHOLD_PX = 48;

const EMPTY_HINT =
  '<p class="ai-chat-empty">Gespräch starten, um Transkript zu sehen</p>';

export class ChatView implements ChatRenderer<HTMLDivElement> {
  private open = false;
  /** Folgt der Chat dem Verlauf? Pausiert, sobald der Nutzer hochscrollt. */
  private autoScroll = true;
  /** Trennt eigene Scroll-Aufrufe von echten Nutzergesten. */
  private isProgrammaticScroll = false;

  /**
   * @param container Container des Controls (trägt die Klasse chat-open)
   * @param panel     Scroll-Container des Chats (.ai-chat-panel)
   * @param messages  Liste der Bubbles (.ai-chat-messages)
   */
  constructor(
    private readonly container: HTMLDivElement,
    private readonly panel: HTMLDivElement,
    private readonly messages: HTMLDivElement,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.container.classList.toggle("chat-open", this.open);

    if (this.open) {
      // Beim Öffnen immer ans Ende, auch wenn zuvor hochgescrollt war.
      this.autoScroll = true;

      // Erst im nächsten Frame: Das Panel wechselt gerade von display:none auf
      // flex, und der Orb-Bereich schrumpft per Transition – im selben Tick
      // stünde noch die alte Geometrie zur Verfügung.
      requestAnimationFrame(() => this.scrollToBottom(true));
    }
  }

  /**
   * Hängt eine Bubble an. Eine User-Bubble landet vor `before`, wenn diese
   * KI-Bubble schon im Panel steht – das User-Transkript kommt oft erst,
   * nachdem die Antwort der KI begonnen hat.
   */
  addBubble(
    role: "user" | "ai",
    text: string,
    before: HTMLDivElement | null,
  ): HTMLDivElement {
    const emptyEl = this.messages.querySelector(".ai-chat-empty");

    if (emptyEl) emptyEl.remove();

    const bubble = document.createElement("div");
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    bubble.textContent = text;

    if (role === "user" && before?.parentElement === this.messages) {
      this.messages.insertBefore(bubble, before);
    } else {
      this.messages.appendChild(bubble);
    }

    this.scrollToBottom();

    return bubble;
  }

  /** Ersetzt den Text einer Bubble – ohne zu scrollen. */
  setText(bubble: HTMLDivElement, text: string): void {
    bubble.textContent = text;
  }

  /**
   * Scrollt den Chat ans Ende, solange der Nutzer mitliest.
   *
   * @param force Auch scrollen, wenn der Nutzer hochgescrollt hat
   *              (beim Öffnen des Chats gewollt).
   */
  scrollToBottom(force = false): void {
    const el = this.panel;

    if (!el) return;
    if (!force && !this.autoScroll) return;

    // Eine Zuweisung an scrollTop feuert selbst ein scroll-Event. Ohne diese
    // Markierung würde onScroll() den eigenen Scroll für eine Nutzergeste
    // halten und das Mitscrollen sofort wieder abschalten.
    this.isProgrammaticScroll = true;
    el.scrollTop = el.scrollHeight;

    requestAnimationFrame(() => {
      this.isProgrammaticScroll = false;
    });
  }

  /** Merkt sich, ob der Nutzer weggescrollt hat oder wieder mitliest. */
  onScroll(): void {
    if (this.isProgrammaticScroll) return;

    const el = this.panel;

    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    this.autoScroll = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD_PX;
  }

  /** Leert das Panel und zeigt wieder den Platzhalter. */
  clear(): void {
    this.autoScroll = true;

    if (this.messages) {
      this.messages.innerHTML = EMPTY_HINT;
    }
  }
}
