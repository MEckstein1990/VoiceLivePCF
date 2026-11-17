/**
 * HTML-Gerüst des Controls und die Element-Referenzen, die das Control braucht.
 */

/** Markup des Controls. Das Event-Log-Panel ist bewusst auskommentiert. */
export const CONTROL_MARKUP = `
            <div class="ai-voice-header">
                <div class="ai-voice-status-label">
                    <span class="ai-voice-status-dot"></span>
                    <span class="ai-voice-status-header">Nicht verbunden</span>
                </div>
                <div style="display:flex;gap:6px">
                  <button class="ai-chat-toggle" title="Chat-Transkript anzeigen">
                    <!-- Zustand: Chat OFFEN → normale Sprechblase -->
                    <svg class="icon-chat-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <!-- Zustand: Chat GESCHLOSSEN → durchgestrichene Sprechblase -->
                    <svg class="icon-chat-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        <line x1="3" y1="3" x2="21" y2="21"/>
                    </svg>
                  </button>                    
                </div>
            </div>
            <div class="ai-voice-orb-area">
                <div class="ai-voice-orb-wrapper">
                    <div class="ai-voice-ring ai-voice-ring-1"></div>
                    <div class="ai-voice-ring ai-voice-ring-2"></div>
                    <div class="ai-voice-ring ai-voice-ring-3"></div>
                    <div class="ai-voice-orb">
                      <!--
                      <svg class="ai-voice-orb-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                          <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-1 14.93V19H9v2h6v-2h-2v-2.07A7.001 7.001 0 0 0 19 11h-2a5 5 0 0 1-10 0H5a7.001 7.001 0 0 0 6 6.93z"/>
                      </svg>
                      -->
                    </div>
                </div>
                <p class="ai-voice-status-text">Inaktiv</p>
                <p class="ai-voice-dormant-hint">Tippen zum Fortsetzen</p>
                <div class="ai-voice-vu-meter">
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                    <div class="ai-voice-bar"></div>
                </div>
            </div>
            <div class="ai-chat-panel">
                <div class="ai-chat-messages">
                    <p class="ai-chat-empty">Gespr\u00e4ch starten, um Transkript zu sehen</p>
                </div>
            </div>
            <div class="ai-voice-footer">
                <button class="ai-voice-action-btn ai-voice-mute-btn" title="Mikrofon stummschalten">
                    <svg class="icon-mic-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                        <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                        <line x1="12" x2="12" y1="19" y2="22"/>
                    </svg>
                    <svg class="icon-mic-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="2" x2="22" y1="2" y2="22"/>
                        <path d="M18.89 13.23A7.12 7.12 0 0 0 19 11v-1"/>
                        <path d="M5 10v1a6.93 6.93 0 0 0 1.39 4.19"/>
                        <path d="M9 10.5V5a3 3 0 0 1 5.14-2.12"/>
                        <path d="M12 18.5a6.95 6.95 0 0 1-3.6-1.02"/>
                        <line x1="12" x2="12" y1="19" y2="22"/>
                    </svg>
                </button>
                <div class="ai-voice-config-warning"></div>
                <button class="ai-voice-action-btn ai-voice-connect-btn" title="Verbindung herstellen">
                    <svg class="icon-waves" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="4" x2="12" y2="20"></line>
                        <line x1="6" y1="10" x2="6" y2="14"></line>
                        <line x1="18" y1="10" x2="18" y2="14"></line>
                    </svg>
                    <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <!--
            <div class="ai-event-log">
                <div class="ai-event-log-header">
                    <span>Event Log</span>
                    <div style="display:flex;gap:6px">
                        <button class="ai-event-log-clear" title="Log leeren">✕</button>
                        <button class="ai-event-log-toggle" title="Log ein-/ausklappen">▼</button>
                    </div>
                </div>
                <div class="ai-event-log-body"></div>
            </div>
            -->
        `;

/** Elemente, auf die das Control nach dem Rendern zugreift. */
export interface UiRefs {
  orb: HTMLDivElement;
  statusText: HTMLParagraphElement;
  statusHeader: HTMLSpanElement;
  vuBars: HTMLDivElement[];
  chatToggleBtn: HTMLButtonElement;
  chatPanel: HTMLDivElement;
  chatMessages: HTMLDivElement;
  muteBtn: HTMLButtonElement;
  connectBtn: HTMLButtonElement;
}

/** Schreibt das Markup in den Container und liefert die Element-Referenzen. */
export function renderTemplate(container: HTMLDivElement): UiRefs {
  container.innerHTML = CONTROL_MARKUP;

  return {
    orb: container.querySelector(".ai-voice-orb") as HTMLDivElement,
    statusText: container.querySelector(".ai-voice-status-text") as HTMLParagraphElement,
    statusHeader: container.querySelector(".ai-voice-status-header") as HTMLSpanElement,
    vuBars: Array.from(container.querySelectorAll(".ai-voice-bar")) as HTMLDivElement[],
    chatToggleBtn: container.querySelector(".ai-chat-toggle") as HTMLButtonElement,
    chatPanel: container.querySelector(".ai-chat-panel") as HTMLDivElement,
    chatMessages: container.querySelector(".ai-chat-messages") as HTMLDivElement,
    muteBtn: container.querySelector(".ai-voice-mute-btn") as HTMLButtonElement,
    connectBtn: container.querySelector(".ai-voice-connect-btn") as HTMLButtonElement,
  };
}
