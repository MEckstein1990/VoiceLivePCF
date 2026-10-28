using System.Net.WebSockets;
using Azure.Core;
using Microsoft.Extensions.Logging;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Baut die Verbindung zu Voice Live für den Agenten aus dem Session-Token auf
/// (Managed Identity bzw. DefaultAzureCredential der Function App).
/// </summary>
internal sealed class VoiceLiveUpstream(
    TokenCredential credential, ILogger<VoiceLiveUpstream> log)
{
    private const string Scope = "https://ai.azure.com/.default";

    /// <summary>Verbundener WebSocket zu Voice Live; der Aufrufer muss ihn entsorgen.</summary>
    public async Task<ClientWebSocket> ConnectAsync(SessionTokenPayload payload, CancellationToken ct)
    {
        var token = await credential.GetTokenAsync(new TokenRequestContext([Scope]), ct);

        // Voice Agent (kind: voice): eigener Endpunkt am Foundry-Projekt, Token nur im Header.
        var url = $"wss://{new Uri(payload.AgentEndpoint).Host}/api/projects/{Uri.EscapeDataString(payload.AgentProjectName)}" +
                  $"/agents/{Uri.EscapeDataString(payload.AgentId)}/endpoint/protocols/voice?api-version=v1";

        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", $"Bearer {token.Token}");
        // Preview-Opt-in und Subprotokoll "realtime" wie im Projects-SDK.
        socket.Options.SetRequestHeader("Foundry-Features", "VoiceAgents=V1Preview");
        socket.Options.AddSubProtocol("realtime");
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
        try
        {
            await socket.ConnectAsync(new Uri(url), ct);
        }
        catch
        {
            socket.Dispose();
            throw;
        }

        log.LogInformation("WS Proxy verbunden: agent={AgentName} project={Project}",
            payload.AgentId, payload.AgentProjectName);
        return socket;
    }
}
