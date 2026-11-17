/**
 * Event-Log des Controls: Konsole, Output-Property EventLog und optional ein
 * DOM-Panel.
 *
 * Das UI-Panel dafür ist im Markup auskommentiert (siehe ui/template.ts) –
 * `element` bleibt entsprechend null, der DOM-Zweig in log() bleibt inaktiv.
 */
export class EventLog {
  private textValue = "";
  private readonly entries: string[] = [];

  /** Optionales Panel, in das jede Zeile zusätzlich geschrieben wird. */
  element: HTMLDivElement | null = null;

  /** Gesamter Log-Text für die Output-Property EventLog. */
  get text(): string {
    return this.textValue;
  }

  log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    this.textValue += entry + "\n";
    this.entries.push(entry);
    console.log("[VoiceLive]", msg);

    if (this.element) {
      const line = document.createElement("div");

      line.className = "ai-event-log-line";

      if (
        msg.includes("FEHLER") ||
        msg.includes("error") ||
        msg.includes("Error")
      ) {
        line.classList.add("ai-event-log-error");
      } else if (msg.includes("WARNUNG") || msg.includes("warning")) {
        line.classList.add("ai-event-log-warn");
      }

      line.textContent = entry;

      this.element.appendChild(line);

      this.element.scrollTop = this.element.scrollHeight;
    }
  }
}
