using System.Net.WebSockets;
using Azure.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace VoiceLiveSessionApi;

/// <summary>
/// WebSocket-Proxy: Leitet eine WebSocket-Verbindung vom Browser an Azure Voice Live weiter
/// und fügt dabei den erforderlichen <c>Authorization: Bearer</c>-Header hinzu,
/// den Browser-WebSocket-APIs nicht selbst setzen können.
///
/// Verbindungsaufbau: GET /api/voice-live/ws?key={PROXY_API_KEY}&amp;agent-id={ID}&amp;agent-project-name={NAME}
///
/// Der Proxy holt eigenständig ein OAuth-Token (Scope: VOICE_LIVE_TOKEN_SCOPE) und
/// baut die Upstream-Verbindung zu wss://{VOICE_LIVE_ENDPOINT}/voice-live/realtime auf.
/// Alle Nachrichten werden transparent in beide Richtungen weitergeleitet.
/// </summary>
public sealed class VoiceLiveWsProxyFunction
{
    private readonly TokenCredential _credential;
    private readonly ILogger<VoiceLiveWsProxyFunction> _logger;
    private readonly string _scope;
    private readonly string _voiceLiveEndpoint;
    private readonly string _apiVersion;
    private readonly string? _proxyApiKey;

    public VoiceLiveWsProxyFunction(
        TokenCredential credential,
        ILogger<VoiceLiveWsProxyFunction> logger)
    {
        _credential = credential;
        _logger = logger;
        _scope = Environment.GetEnvironmentVariable("VOICE_LIVE_TOKEN_SCOPE")
            ?? "https://ai.azure.com/.default";
        _voiceLiveEndpoint = Environment.GetEnvironmentVariable("VOICE_LIVE_ENDPOINT")
            ?? "https://test-speechlive-mcp.services.ai.azure.com";
        _apiVersion = Environment.GetEnvironmentVariable("VOICE_LIVE_API_VERSION")
            ?? "2026-01-01-preview";
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
    }

    [Function("VoiceLiveWsProxy")]
    public async Task Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "voice-live/ws")]
        HttpRequest req)
    {
        // Proxy-Key validieren (Query-Param 'key' oder Header 'X-Proxy-Key')
        if (!IsAuthorized(req))
        {
            req.HttpContext.Response.StatusCode = 401;
            await req.HttpContext.Response.WriteAsync("Unauthorized");
            return;
        }

        if (!req.HttpContext.WebSockets.IsWebSocketRequest)
        {
            req.HttpContext.Response.StatusCode = 400;
            await req.HttpContext.Response.WriteAsync("WebSocket upgrade required");
            return;
        }

        var agentId = req.Query["agent-id"].FirstOrDefault()
            ?? throw new ArgumentException("agent-id query param required");
        var projectName = req.Query["agent-project-name"].FirstOrDefault()
            ?? "proj-default";

        // OAuth-Token holen (für Authorization-Header und agent-access-token)
        var tokenResult = await _credential.GetTokenAsync(
            new TokenRequestContext([_scope]),
            req.HttpContext.RequestAborted);

        var host = new Uri(_voiceLiveEndpoint).Host;
        var encodedToken = Uri.EscapeDataString(tokenResult.Token);
        var targetUrl = $"wss://{host}/voice-live/realtime" +
                        $"?api-version={_apiVersion}" +
                        $"&agent-id={Uri.EscapeDataString(agentId)}" +
                        $"&agent-project-name={Uri.EscapeDataString(projectName)}" +
                        $"&agent-access-token={encodedToken}";

        // Browser-WebSocket annehmen
        var clientSocket = await req.HttpContext.WebSockets.AcceptWebSocketAsync();

        // Upstream zu Azure Voice Live verbinden (mit Authorization-Header)
        using var serverSocket = new ClientWebSocket();
        serverSocket.Options.SetRequestHeader("Authorization", $"Bearer {tokenResult.Token}");

        try
        {
            await serverSocket.ConnectAsync(new Uri(targetUrl), req.HttpContext.RequestAborted);
            _logger.LogInformation("WS Proxy: upstream verbunden, Agent={AgentId}", agentId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "WS Proxy: upstream Verbindung fehlgeschlagen, Agent={AgentId}", agentId);
            await clientSocket.CloseAsync(
                WebSocketCloseStatus.InternalServerError,
                "Upstream connection failed",
                CancellationToken.None);
            return;
        }

        // Bidirektionales Relay starten
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(req.HttpContext.RequestAborted);
        var clientToServer = RelayAsync(clientSocket, serverSocket, cts, "client→server");
        var serverToClient = RelayAsync(serverSocket, clientSocket, cts, "server→client");

        await Task.WhenAny(clientToServer, serverToClient);
        cts.Cancel();
        try { await Task.WhenAll(clientToServer, serverToClient).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch { /* Cleanup-Fehler ignorieren */ }

        _logger.LogInformation("WS Proxy: Session beendet, Agent={AgentId}", agentId);
    }

    private bool IsAuthorized(HttpRequest req)
    {
        if (string.IsNullOrEmpty(_proxyApiKey)) return true; // Dev-Modus: kein Key konfiguriert
        var provided = req.Query["key"].FirstOrDefault()
            ?? req.Headers["X-Proxy-Key"].FirstOrDefault();
        return provided == _proxyApiKey;
    }

    private async Task RelayAsync(
        WebSocket source,
        WebSocket target,
        CancellationTokenSource cts,
        string direction)
    {
        var buffer = new byte[65536]; // 64 KB – ausreichend für Audio-Chunks und JSON-Frames
        try
        {
            while (!cts.IsCancellationRequested && source.State == WebSocketState.Open)
            {
                var result = await source.ReceiveAsync(
                    new ArraySegment<byte>(buffer), cts.Token);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _logger.LogDebug("WS Proxy [{Direction}]: Close empfangen", direction);
                    if (target.State == WebSocketState.Open)
                        await target.CloseAsync(
                            result.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                            result.CloseStatusDescription ?? string.Empty,
                            CancellationToken.None);
                    break;
                }

                if (target.State == WebSocketState.Open)
                    await target.SendAsync(
                        new ArraySegment<byte>(buffer, 0, result.Count),
                        result.MessageType,
                        result.EndOfMessage,
                        cts.Token);
            }
        }
        catch (OperationCanceledException) { /* Normales Beenden */ }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "WS Proxy [{Direction}]: Relay-Fehler", direction);
        }
        finally
        {
            cts.Cancel();
        }
    }
}
