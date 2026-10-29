using System.Net.WebSockets;
using Microsoft.Extensions.Logging;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Leitet Nachrichten von <c>source</c> nach <c>target</c> weiter, bis eine Seite schließt oder
/// abgebrochen wird. Weiß nichts über Voice Live.
///
/// Ohne <see cref="Transform"/> werden Frames ungepuffert durchgereicht (z.B. Audio vom Server).
/// Mit Transform werden Textnachrichten vollständig gepuffert (höchstens
/// <see cref="MaxMessageBytes"/>) und können vor dem Senden ersetzt werden.
/// </summary>
internal sealed class WebSocketRelay(WebSocket source, WebSocket target, string direction, ILogger log)
{
    /// <summary>Obergrenze für gepufferte Nachrichten; größere beenden die Verbindung.</summary>
    public const int MaxMessageBytes = 1024 * 1024;

    /// <summary>Gibt die zu sendende Nachricht zurück, oder null für "unverändert".</summary>
    public Func<byte[], byte[]?>? Transform { get; init; }

    public async Task RunAsync(CancellationTokenSource cts)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();

        try
        {
            while (!cts.IsCancellationRequested && source.State == WebSocketState.Open)
            {
                var result = await source.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    log.LogInformation(
                        "WS Proxy [{Direction}]: Close empfangen – Status={CloseStatus} Desc={CloseDescription}",
                        direction, result.CloseStatus, result.CloseStatusDescription);
                    if (target.State == WebSocketState.Open)
                        await target.CloseAsync(
                            result.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                            result.CloseStatusDescription ?? string.Empty,
                            CancellationToken.None);
                    return;
                }

                if (Transform is null || result.MessageType != WebSocketMessageType.Text)
                {
                    await SendAsync(new ArraySegment<byte>(buffer, 0, result.Count),
                        result.MessageType, result.EndOfMessage, cts.Token);
                    continue;
                }

                if (message.Length + result.Count > MaxMessageBytes)
                {
                    log.LogWarning("WS Proxy [{Direction}]: Nachricht größer als {Max} Bytes, Verbindung wird beendet",
                        direction, MaxMessageBytes);
                    return;
                }

                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                    continue;

                var payload = message.ToArray();
                message.SetLength(0);
                await SendAsync(Transform(payload) ?? payload, WebSocketMessageType.Text, endOfMessage: true, cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            log.LogWarning(ex, "WS Proxy [{Direction}]: Relay-Fehler", direction);
        }
        finally { cts.Cancel(); }
    }

    private Task SendAsync(ArraySegment<byte> data, WebSocketMessageType type, bool endOfMessage, CancellationToken ct)
        => target.State == WebSocketState.Open
            ? target.SendAsync(data, type, endOfMessage, ct)
            : Task.CompletedTask;
}
