/**
 * Worklet-Code als Vanilla JS (kein TS!) – wird als Blob geladen, das löst
 * die PCF-Pfad-Probleme.
 *
 * Zwei Eingänge: 0 ist das Mikrofon, 1 die Echo-Referenz (das, was gerade
 * über die Lautsprecher läuft). Beide werden im selben Render-Quantum
 * abgegriffen und sind dadurch sample-genau zueinander ausgerichtet – das
 * ist die Voraussetzung für die serverseitige Echounterdrückung.
 */
export const WORKLET_CODE = `
    class Processor extends AudioWorkletProcessor {
      process(inputs, outputs, parameters) {
        const mic = inputs[0]?.[0];
        if (mic) {
          const reference = inputs[1]?.[0];

          // WICHTIG: Float32Arrays kopieren, bevor sie an den Main-Thread
          // gehen! Der Browser leert die Puffer sonst sofort wieder.
          //
          // Spielt gerade nichts, liefert der Browser keinen zweiten Eingang.
          // Dann Stille gleicher Länge senden – der Referenzkanal darf nie
          // fehlen, sonst verrutscht die Zuordnung der Sample-Paare.
          this.port.postMessage({
            mic: new Float32Array(mic),
            reference: reference
              ? new Float32Array(reference)
              : new Float32Array(mic.length),
          });
        }
        return true;
      }
    }
    registerProcessor("processor", Processor);
  `;
