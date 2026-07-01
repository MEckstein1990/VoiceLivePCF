# VoiceLive PCF Control

Echtzeit-Sprachdialog mit einem KI-Assistenten für **Power Apps** und **Dynamics 365** – realisiert als PowerApps Component Framework (PCF) Control.

Das Control nimmt Sprache über das Mikrofon auf, streamt sie in Echtzeit an einen **Azure AI Foundry Agent** (über die **Azure Voice Live API**) und gibt die Antwort des Agenten als synthetische Sprache wieder. Eine integrierte Chat-Ansicht zeigt das Transkript live im Messenger-Stil an. Eine animierte Orb-Visualisierung signalisiert jederzeit den aktuellen Zustand (Zuhören, Nutzer spricht, KI spricht, Fehler).

> **Hinweis:** Dieses Repository enthält ausschließlich das **Frontend** (das PCF-Control und das Solution-Packaging). Die Client-Anmeldedaten (Endpunkte, API-Keys) werden bewusst **nicht** im Client gehalten, sondern über einen serverseitigen **WebSocket-Proxy** (Azure Function App) vermittelt. Dieser Proxy ist eine Betriebsvoraussetzung und wird separat bereitgestellt (siehe [Architektur](#architektur)).

---

## Inhaltsverzeichnis

- [Architektur](#architektur)
- [Voraussetzungen](#voraussetzungen)
- [Projekt einrichten](#projekt-einrichten)
- [Solution bauen & importieren](#solution-bauen--importieren)
- [Konfiguration in Power Apps](#konfiguration-in-power-apps)
- [Control-Properties](#control-properties)
- [Verfügbare npm-Scripts](#verfügbare-npm-scripts)
- [Projektstruktur](#projektstruktur)
- [Versionierung](#versionierung)
- [Sicherheitshinweise](#sicherheitshinweise)
- [Technologie-Stack](#technologie-stack)

---

## Architektur

Das Control kommuniziert nicht direkt mit Azure, sondern über einen serverseitigen Proxy. Dadurch bleiben API-Keys und Agent-Endpunkte auf dem Server, und die Benutzeridentität (`caller-id`) kann für nachgelagerte Berechtigungsprüfungen mitgeführt werden.

```
┌──────────────────────┐        wss:// (Audio + Events)      ┌───────────────────────────┐
│  PCF VoiceLive        │ ─────────────────────────────────▶ │  WebSocket-Proxy          │
│  Control (Browser)    │                                     │  (Azure Function App)     │
│                       │ ◀───────────────────────────────── │  = TokenEndpoint          │
│  • Mikrofon / Web     │                                     └────────────┬──────────────┘
│    Audio (PCM16)      │                                                  │
│  • Chat-Transkript    │                                                  ▼
│  • State Machine      │                                     ┌───────────────────────────┐
└──────────────────────┘                                     │  Azure Voice Live API     │
                                                             │  + Azure AI Foundry Agent  │
                                                             └───────────────────────────┘
```

**Ablauf einer Session:**

1. Der Maker bindet das Control ein und setzt die Bound-Property `Connected = true` (z. B. per Button).
2. Das Control öffnet eine WebSocket-Verbindung zum Proxy:
   `wss://{TokenEndpoint}/api/voice-live/ws?key=…&agent-name=…&agent-project-name=…&endpoint=…&caller-id=…`
3. Nach dem Öffnen sendet das Control eine `session.update`-Nachricht mit Voice-, VAD-, Rauschunterdrückungs- und Transkriptions-Einstellungen.
4. Mikrofon-Audio (24 kHz PCM16) wird gestreamt; die Antwort des Agenten kommt als Audio-Deltas zurück und wird abgespielt.
5. Live-Transkripte (Nutzer & KI) werden im Chat-Panel angezeigt und über die Output-Property `Transcript` bereitgestellt.
6. Bei unerwartetem Verbindungsabbruch versucht das Control automatisch einen Reconnect (exponentielles Backoff, inkl. Wiedereinspielen des bisherigen Gesprächsverlaufs).

Der Proxy stellt zwei Endpunkte bereit, die das Control nutzt:

| Endpunkt | Zweck |
|----------|-------|
| `GET /api/voice-live/token` | Liefert einen kurzlebigen Agent-Access-Token (mit Header `X-Proxy-Key`) |
| `WSS /api/voice-live/ws` | WebSocket-Proxy zur Azure Voice Live API |

---

## Voraussetzungen

| Tool | Version | Installation |
|------|---------|--------------|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org/) |
| **npm** | (kommt mit Node.js) | — |
| **.NET SDK** | 6.0+ | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| **.NET Framework 4.6.2 Targeting Pack** | — | [Download](https://dotnet.microsoft.com/download/dotnet-framework/net462) |
| **Power Platform CLI** (`pac`) | aktuell | siehe unten |

> Das .NET SDK und das Targeting Pack werden **nur für das Bauen der Solution** (`.cdsproj`) benötigt, nicht für die reine Control-Entwicklung.

### Power Platform CLI installieren

**Option A — als .NET Global Tool (empfohlen):**

```bash
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

**Option B — als VS Code Extension:**

In VS Code die Extension **„Power Platform Tools"** installieren (Publisher: Microsoft). Diese bringt die `pac` CLI automatisch mit.

Nach der Installation prüfen:

```bash
pac --version
```

---

## Projekt einrichten

```bash
# 1. Repository klonen
git clone <REPO-URL>
cd VoiceLive-PCF-Control

# 2. Dependencies installieren
npm install

# 3. Control bauen
npm run build

# 4. Lokalen Test-Harness starten
npm start
# oder mit Auto-Reload:
npm run start:watch
```

> **Mikrofon-Hinweis:** Das Control benötigt `getUserMedia`, das nur über **HTTPS** bzw. `localhost` verfügbar ist. Der lokale Test-Harness und Power Apps erfüllen diese Bedingung. Zusätzlich muss ein erreichbarer WebSocket-Proxy konfiguriert sein, damit eine Session zustande kommt.

---

## Solution bauen & importieren

```bash
# 1. Control bauen (falls noch nicht geschehen)
npm run build

# 2. Solution bauen
cd Solution
dotnet build /p:configuration=Release

# → ZIP-Datei liegt unter: Solution/bin/Release/Solution.zip
```

**Import in Power Apps:**

1. [make.powerapps.com](https://make.powerapps.com) öffnen
2. **Lösungen → Importieren →** ZIP-Datei hochladen
3. Die Solution wird als **managed + unmanaged** paketiert (Publisher: `AdessoSE`, Prefix: `adesso`)

---

## Konfiguration in Power Apps

Nach dem Import kann das Control auf ein Canvas- oder Custom-Page-Formular gezogen werden. Die folgenden Pflicht-Properties müssen gesetzt werden (siehe [Control-Properties](#control-properties)):

- `AgentId`, `AgentProjectName`, `AgentEndpoint` – Ziel-Agent in Azure AI Foundry
- `TokenEndpoint`, `ProxyKey` – Adresse und Schlüssel des WebSocket-Proxys
- `Connected` – an eine Variable/Toggle binden, um Sessions zu starten/beenden

### Benutzeridentität (`caller-id`)

Damit der Agent bzw. nachgelagerte Systeme den anrufenden Benutzer kennen, wird die System-User-GUID über die Property `UserId` übergeben. In **Canvas Apps** ist `User().ObjectId` (Azure AD Object ID) verfügbar; die zugehörige Dataverse-`SystemUserId` lässt sich per Formel auflösen:

```powerfx
LookUp(Users, 'Azure AD Object ID' = User().ObjectId, systemuserid)
```

Das Ergebnis wird an die Property `UserId` gebunden und vom Control als `caller-id`-Query-Parameter an den Proxy übergeben.

---

## Control-Properties

### Eingabe-Properties

| Property | Typ | Pflicht | Beschreibung |
|----------|-----|---------|--------------|
| `AgentId` | Text | Ja | Name/ID des Azure AI Foundry Agents |
| `AgentProjectName` | Text | Ja | Foundry-Projektname des Agents |
| `AgentEndpoint` | Text | Ja | Foundry-Endpoint, z. B. `https://<resource>.services.ai.azure.com` |
| `TokenEndpoint` | Text | Ja | Basis-URL des WebSocket-Proxys (Azure Function App) |
| `ProxyKey` | Text | Ja | Zugriffsschlüssel für den Proxy (Header `X-Proxy-Key` / `key`-Query) |
| `UserId` | Text | Nein | Dataverse-`SystemUserId` des Nutzers → wird als `caller-id` übermittelt |
| `Connected` | TwoOptions (bound) | Ja | `true` startet die Session, `false` beendet sie |
| `AgentVoice` | Enum | Ja | Sprachstimme (siehe Tabelle unten) |
| `AgentLanguage` | Enum | Ja | Sprache: `de`, `en` oder `fr` |
| `VoiceSpeed` | Enum | Ja | Sprechtempo: `langsam` (0.9), `mittel` (1.0), `schnell` (1.1), `sehr schnell` (1.3) |
| `SilenceDurationMs` | Whole | Ja | Stille-Dauer (ms) bis Sprechpause erkannt wird (VAD), Standard `1500` |
| `VadThreshold` | Decimal | Ja | Empfindlichkeit der Spracherkennung (VAD), Standard `0.5` |
| `MsalClientId` | Text | Nein | _Reserviert / derzeit deaktiviert_ (siehe Hinweis) |
| `TenantId` | Text | Nein | _Reserviert / derzeit deaktiviert_ (siehe Hinweis) |
| `DataverseOrgUrl` | Text | Nein | _Reserviert / derzeit deaktiviert_ (siehe Hinweis) |

> **Hinweis zu MSAL-Properties:** `MsalClientId`, `TenantId` und `DataverseOrgUrl` gehörten zu einem früheren, clientseitigen MSAL-Token-Flow für Dataverse Row-Level-Security. Dieser Flow ist im Code aktuell **deaktiviert** – die Benutzeridentität wird stattdessen serverseitig über `caller-id` (aus `UserId`) verarbeitet. Die Properties bleiben aus Kompatibilitätsgründen im Manifest, haben derzeit aber keine Wirkung.

### Verfügbare Stimmen (`AgentVoice`)

| Wert | Stimme |
|------|--------|
| `de-DE-Florian:DragonHDLatestNeural` | Florian (HD) — Standard |
| `de-DE-KatjaNeural` | Katja |
| `de-DE-Seraphina:DragonHDLatestNeural` | Seraphina (HD) |
| `de-DE-ConradNeural` | Conrad |

### Ausgabe-Properties

| Property | Typ | Beschreibung |
|----------|-----|--------------|
| `ConnectionStatus` | Text | Aktueller Zustand: `idle`, `connecting`, `reconnecting`, `listening`, `user-speaking`, `ai-speaking` oder `error` |
| `Transcript` | Multiline | Vollständiges Gesprächstranskript im Format `[User]: …` / `[KI]: …` |
| `EventLog` | Multiline | Diagnose-/Debug-Log der Session-Events |

---

## Verfügbare npm-Scripts

| Script | Beschreibung |
|--------|--------------|
| `npm run build` | Control kompilieren und bundlen |
| `npm start` | Lokalen Test-Harness starten |
| `npm run start:watch` | Test-Harness mit Auto-Reload |
| `npm run lint` | ESLint ausführen |
| `npm run lint:fix` | ESLint mit Auto-Fix |
| `npm run clean` | Build-Outputs löschen |
| `npm run rebuild` | Clean + Build |
| `npm run refreshTypes` | `ManifestTypes.d.ts` neu generieren |

---

## Projektstruktur

```
VoiceLive-PCF-Control/
├── VoiceLiveControl/                    # Das PCF-Control
│   ├── index.ts                         # Hauptlogik (WebSocket, Audio, Chat-UI, State Machine)
│   ├── ControlManifest.Input.xml        # Control-Manifest (Properties, Outputs, externe Dienste)
│   ├── css/
│   │   └── AiVoiceControl.css           # Styling (Dark-Mode, Orb-Animation, VU-Meter, Chat-Bubbles)
│   ├── strings/
│   │   └── VoiceLiveControl.1033.resx   # Lokalisierung (Display-Namen & Beschreibungen)
│   └── generated/
│       └── ManifestTypes.d.ts           # Auto-generierte Typen (NICHT manuell bearbeiten)
│
├── Solution/                            # PowerApps Solution-Projekt (Packaging)
│   ├── Solution.cdsproj                 # MSBuild-Projekt für die Solution
│   └── src/Other/
│       ├── Solution.xml                 # Solution-Manifest (Version, Publisher)
│       ├── Customizations.xml           # Anpassungs-XML
│       └── Relationships.xml            # Beziehungen
│
├── package.json                         # npm-Dependencies und Scripts
├── pcfconfig.json                       # PCF-Konfiguration (Output-Pfad, Manifest-Pfad)
├── PCF-Test.pcfproj                     # MSBuild-Projektdatei für das Control
├── tsconfig.json                        # TypeScript-Konfiguration
├── eslint.config.mjs                    # ESLint mit Power Apps Checker Rules
└── .gitignore                           # Git-Ignore-Regeln
```

### Wichtige Dateien im Detail

| Datei | Beschreibung |
|-------|--------------|
| `VoiceLiveControl/index.ts` | Gesamte Control-Logik: WebSocket-Verbindung zum Proxy, Audio-Aufnahme/-Wiedergabe (Web Audio API, 24 kHz PCM16), Resampling, Live-Transkription, Chat-UI, Reconnect mit Backoff, State Machine (`idle → connecting → listening ↔ user-speaking ↔ ai-speaking`), Barge-In (Unterbrechen der KI), VU-Meter-Visualisierung |
| `VoiceLiveControl/ControlManifest.Input.xml` | Definiert alle Control-Properties und Outputs sowie die freigegebenen externen Dienste (`*.services.ai.azure.com`, `*.cognitiveservices.azure.com`, `*.azurewebsites.net`, `login.microsoftonline.com`) |
| `VoiceLiveControl/css/AiVoiceControl.css` | Dark-Mode-Design mit zustandsabhängigen Farben/Animationen: blauer Orb (Nutzer spricht), lila Orb (KI spricht), Spinner (Connecting), rote Anzeige (Error), Messenger-Style Chat-Bubbles |
| `Solution/src/Other/Solution.xml` | Solution-Manifest mit Versionsnummer, Publisher `AdessoSE` (Prefix: `adesso`) und Package-Typ (managed + unmanaged) |

---

## Versionierung

Vor jedem PowerApps-Import müssen **beide** Versionen synchron hochgezählt werden:

1. **Control-Version** in `VoiceLiveControl/ControlManifest.Input.xml`:
   ```xml
   <control ... version="1.20.0" ...>
   ```

2. **Solution-Version** in `Solution/src/Other/Solution.xml`:
   ```xml
   <Version>1.20.0.0</Version>
   ```

> Power Apps aktualisiert ein bereits importiertes Control nur bei **höherer** Versionsnummer. Wird die Version nicht erhöht, greift der neue Code im Zielsystem nicht.

---

## Sicherheitshinweise

- **Keine Secrets committen.** `ProxyKey`, Endpunkte und ähnliche Anmeldedaten gehören in die Power-Apps-Konfiguration (Property-Bindung / Umgebungsvariablen), **nicht** in den Quellcode oder in dieses Repository. Vor der Weitergabe an den Kunden sollten evtl. vorhandene Default-/Beispielwerte aus dem Code entfernt werden.
- **Least-Privilege für den Proxy-Key.** Der `ProxyKey` sollte ausschließlich Zugriff auf den Voice-Live-Proxy gewähren und regelmäßig rotierbar sein.
- **Benutzeridentität.** Die `caller-id` (aus `UserId`) dient der serverseitigen Autorisierung. Sicherheitsentscheidungen dürfen nicht allein auf clientseitig übergebenen Werten beruhen – die endgültige Prüfung erfolgt im Backend/Proxy.

---

## Technologie-Stack

- **TypeScript** — Control-Logik
- **Web Audio API** — Mikrofon-Aufnahme und Audio-Wiedergabe (24 kHz PCM16)
- **WebSocket** — Echtzeit-Kommunikation mit dem Voice-Live-Proxy
- **Azure Voice Live API** — Spracherkennung, Sprachsynthese, VAD, Rauschunterdrückung
- **Azure AI Foundry Agent** — Dialog- und Tool-Logik des KI-Assistenten
- **PCF (PowerApps Component Framework)** — Integration in Power Apps / Dynamics 365
- **.NET / MSBuild** — Solution-Packaging für den PowerApps-Import
