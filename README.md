# VoiceLive PCF Control

Echtzeit-Sprach-Dialog mit KI-Assistent via Azure Voice Live API — als PowerApps Component Framework (PCF) Control für Power Apps und Dynamics 365.

Das Control verbindet sich per WebSocket mit der Azure Voice Live API, nimmt Sprache über das Mikrofon auf, sendet sie in Echtzeit an ein KI-Modell und gibt die KI-Antwort als Sprache wieder. Eine integrierte Chat-Ansicht zeigt das Transkript live an.

---

## Voraussetzungen

| Tool | Version | Installation |
|------|---------|-------------|
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org/) |
| **npm** | (kommt mit Node.js) | — |
| **.NET SDK** | 6.0+ | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| **.NET Framework 4.6.2 Targeting Pack** | — | [Download](https://dotnet.microsoft.com/download/dotnet-framework/net462) |
| **Power Platform CLI** (`pac`) | aktuell | siehe unten |

### Power Platform CLI installieren

**Option A — als .NET Global Tool (empfohlen):**

```bash
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

**Option B — als VS Code Extension:**

In VS Code die Extension **"Power Platform Tools"** installieren (Publisher: Microsoft). Diese bringt die `pac` CLI automatisch mit.

Nach der Installation prüfen:

```bash
pac --version
```

---

## Projekt einrichten

```bash
# 1. Repo klonen
git clone <REPO-URL>
cd VoiceLive-PCF-Control

# 2. Dependencies installieren
npm install

# 3. Control bauen
npm run build

# 4. Lokaler Test-Harness starten
npm start
# oder mit Auto-Reload:
npm run start:watch
```

---

## Solution für PowerApps bauen & importieren

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
2. Lösungen → Importieren → ZIP-Datei hochladen
3. Solution wird als **managed + unmanaged** importiert

---

## Verfügbare npm-Scripts

| Script | Beschreibung |
|--------|-------------|
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
├── VoiceLiveControl/                    # Das PCF Control
│   ├── index.ts                         # Hauptlogik (WebSocket, Audio, Chat-UI, State Machine)
│   ├── ControlManifest.Input.xml        # Control-Manifest (Properties, Outputs, externe Dienste)
│   ├── css/
│   │   └── AiVoiceControl.css           # Styling (Dark-Mode, Orb-Animation, VU-Meter, Chat-Bubbles)
│   ├── strings/
│   │   └── VoiceLiveControl.1033.resx   # Lokalisierung (Display-Namen & Beschreibungen)
│   └── generated/
│       └── ManifestTypes.d.ts           # Auto-generierte Typen (NICHT manuell bearbeiten)
│
├── Solution/                            # PowerApps Solution-Projekt
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
|-------|-------------|
| `VoiceLiveControl/index.ts` | Gesamte Control-Logik: WebSocket-Verbindung zur Azure Voice Live API, Audio-Aufnahme und -Wiedergabe (Web Audio API, 24kHz PCM16), Resampling, Live-Transkription, Chat-UI mit User/KI-Bubbles, State Machine (idle → connecting → listening ↔ user-speaking ↔ ai-speaking), VU-Meter-Visualisierung |
| `VoiceLiveControl/ControlManifest.Input.xml` | Definiert die Control-Properties: `AuthMode` (APIKey/OAuthToken), `APIKey`, `Token`, `Endpoint`, `ModelName`, `SystemPrompt`, `Connected` (bound, steuert Session-Start/Stop) sowie die Outputs `ConnectionStatus` und `Transcript` |
| `VoiceLiveControl/css/AiVoiceControl.css` | Dark-Mode Design mit zustandsabhängigen Farben/Animationen: blauer Orb (User spricht), lila Orb (KI spricht), Spinner (Connecting), rote Anzeige (Error). WhatsApp-Style Chat-Bubbles |
| `Solution/src/Other/Solution.xml` | Solution-Manifest mit Versionsnummer, Publisher `AdessoSE` (Prefix: `adesso`) und Package-Typ (managed + unmanaged) |

---

## Control-Properties

### Eingabe-Properties

| Property | Typ | Pflicht | Beschreibung |
|----------|-----|---------|-------------|
| `AuthMode` | Enum | Ja | `APIKey` (Dev/Test) oder `OAuthToken` (Produktion via Custom Connector) |
| `APIKey` | Text | Nur bei APIKey | Azure AI Services Schlüssel |
| `Token` | Text | Nur bei OAuthToken | Kurzlebiger Bearer-Token (JWT, ca. 1h Gültigkeit) |
| `Endpoint` | Text | Ja | Azure-Endpoint, z.B. `https://myresource.cognitiveservices.azure.com` |
| `ModelName` | Text | Ja | KI-Modellname, z.B. `gpt-4.1` |
| `SystemPrompt` | Multiline Text | Nein | Optionaler System-Prompt (Standard: deutscher Außendienst-Assistent) |
| `Connected` | Boolean (bound) | Ja | `true` startet die Session, `false` beendet sie |

### Ausgabe-Properties

| Property | Beschreibung |
|----------|-------------|
| `ConnectionStatus` | Aktueller Zustand: `idle`, `connecting`, `listening`, `user-speaking`, `ai-speaking` oder `error` |
| `Transcript` | Vollständiges Gesprächstranskript im Format `[User]: .../[KI]: ...` |

---

## Versionierung

Vor jedem PowerApps-Import müssen **beide** Versionen synchron hochgezählt werden:

1. **Control-Version** in `VoiceLiveControl/ControlManifest.Input.xml`:
   ```xml
   <control ... version="1.14.0" ...>
   ```

2. **Solution-Version** in `Solution/src/Other/Solution.xml`:
   ```xml
   <Version>1.14.0.0</Version>
   ```

---

## Technologie-Stack

- **TypeScript** — Control-Logik
- **Web Audio API** — Mikrofon-Aufnahme und Audio-Wiedergabe
- **WebSocket** — Echtzeit-Kommunikation mit Azure Voice Live API
- **Azure AI Services** — Spracherkennung, KI-Modell, Sprachsynthese
- **PCF (PowerApps Component Framework)** — Integration in Power Apps / Dynamics 365
- **.NET / MSBuild** — Solution-Packaging für PowerApps-Import
