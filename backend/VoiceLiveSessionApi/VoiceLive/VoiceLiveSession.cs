using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Eine Proxy-Verbindung zwischen Client und Voice Live, von Aufbau bis Abbau.
/// Hält keinen gemeinsamen Zustand – jede Verbindung ist für sich, auch über Instanzen hinweg.
///
/// Interception: das erste session.update des Clients bekommt das MCP-Tool des Session-Ziels,
/// mit eigenem MCP-Token als Authorization (<see cref="McpServer.TryInjectInto"/>).
/// </summary>
internal sealed class VoiceLiveSession(
    SessionTokenPayload payload,
    WebSocket client,
    VoiceLiveUpstream upstream,
    McpServerResolver mcpServers,
    DataverseTokenService dataverseTokens,
    ILogger<VoiceLiveSession> log)
{
    public async Task RunAsync(CancellationToken ct)
    {
        ClientWebSocket server;
        try
        {
            server = await upstream.ConnectAsync(payload, ct);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "WS Proxy: Upstream-Verbindung fehlgeschlagen");
            if (client.State == WebSocketState.Open)
                await client.CloseAsync(WebSocketCloseStatus.InternalServerError,
                    "Upstream connection failed", CancellationToken.None);
            return;
        }

        using (server)
        using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            var clientToServer = new WebSocketRelay(client, server, "client→server", log)
            {
                Transform = CreateMcpTransform()
            }.RunAsync(cts);
            var serverToClient = new WebSocketRelay(server, client, "server→client", log).RunAsync(cts);

            await Task.WhenAny(clientToServer, serverToClient);
            cts.Cancel();
            try { await Task.WhenAll(clientToServer, serverToClient).WaitAsync(TimeSpan.FromSeconds(5)); }
            catch { /* Cleanup-Fehler ignorieren */ }
        }

        log.LogInformation("WS Proxy: Session beendet, Agent={AgentName}", payload.AgentId);
    }

    /// <summary>
    /// Transform für client→server, das genau einmal das MCP-Tool in session.update einsetzt.
    /// Null, wenn kein MCP-Tool vorgesehen ist (User-Token nicht mehr gültig oder kein MCP-Server am Ziel).
    /// </summary>
    private Func<byte[], byte[]?>? CreateMcpTransform()
    {
        // Eigenes MCP-Token, nicht das Session-Token des Clients: enthält Ziel, Org und
        // User-Token verschlüsselt.
        var mcpToken = dataverseTokens.Issue(payload);
        var mcpServer = mcpServers.Resolve(payload.TargetName);
        if (mcpToken is null || mcpServer is null)
            return null;

        var injected = false;
        return message =>
        {
            if (injected)
                return null;

            try
            {
                var result = mcpServer.TryInjectInto(message, mcpToken);
                if (result is not null)
                {
                    injected = true;
                    log.LogInformation("WS Proxy: MCP-Tool {Label} in session.update injiziert", mcpServer.Label);
                }
                return result;
            }
            catch (JsonException ex)
            {
                log.LogWarning(ex, "WS Proxy: Client-Nachricht ist kein gültiges JSON, unverändert weitergeleitet");
                return null;
            }
        };
    }
}
