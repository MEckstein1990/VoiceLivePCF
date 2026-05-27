using System.Net.WebSockets;
using Azure.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace VoiceLiveSessionApi;

/// <summary>
/// ASP.NET Core IStartupFilter that adds a WebSocket proxy for Azure AI Voice Live.
/// Using IStartupFilter is the only way to insert real ASP.NET Core middleware into
/// an Azure Functions isolated worker app, because the Functions host intercepts
/// HTTP requests before they reach Function code – WebSocket upgrades never arrive
/// at Function triggers. This filter runs BEFORE the Functions host pipeline.
/// </summary>
internal sealed class VoiceLiveWsStartupFilter(
    TokenCredential credential,
    ILoggerFactory loggerFactory) : IStartupFilter
{
    private readonly ILogger _log = loggerFactory.CreateLogger("VoiceLiveWsProxy");

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseWebSockets();
            app.Use(async (context, nextMiddleware) =>
            {
                if (context.Request.Path.StartsWithSegments("/api/voice-live/ws")
                    && context.WebSockets.IsWebSocketRequest)
                {
                    await HandleAsync(context);
                    return;
                }
                await nextMiddleware(context);
            });

            // Restliche Middleware-Pipeline (inkl. Azure Functions Host) aufrufen
            next(app);
        };
    }

    private async Task HandleAsync(HttpContext context)
    {
        // Proxy-Key validieren
        var proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
        var providedKey = context.Request.Query["key"].FirstOrDefault()
            ?? context.Request.Headers["X-Proxy-Key"].FirstOrDefault();
        if (!string.IsNullOrEmpty(proxyApiKey) && providedKey != proxyApiKey)
        {
            context.Response.StatusCode = 401;
            return;
        }

        var agentName   = context.Request.Query["agent-name"].FirstOrDefault() ?? "";
        var projectName = context.Request.Query["agent-project-name"].FirstOrDefault() ?? "proj-default";

        var scope      = Environment.GetEnvironmentVariable("VOICE_LIVE_TOKEN_SCOPE")
                         ?? "https://ai.azure.com/.default";
        var endpoint   = Environment.GetEnvironmentVariable("VOICE_LIVE_ENDPOINT")
                         ?? "https://test-speechlive-mcp.services.ai.azure.com";
        var apiVersion = Environment.GetEnvironmentVariable("VOICE_LIVE_API_VERSION")
                         ?? "2026-01-01-preview";

        var tokenResult = await credential.GetTokenAsync(
            new TokenRequestContext([scope]), context.RequestAborted);

        var upstreamHost = new Uri(endpoint).Host;
        var targetUrl    = $"wss://{upstreamHost}/voice-live/realtime?api-version={apiVersion}" +
                           $"&agent-name={Uri.EscapeDataString(agentName)}" +
                           $"&agent-project-name={Uri.EscapeDataString(projectName)}";

        var clientSocket = await context.WebSockets.AcceptWebSocketAsync();

        using var serverSocket = new ClientWebSocket();
        serverSocket.Options.SetRequestHeader("Authorization", $"Bearer {tokenResult.Token}");

        try
        {
            await serverSocket.ConnectAsync(new Uri(targetUrl), context.RequestAborted);
            _log.LogInformation("WS Proxy verbunden: agent={AgentName} project={Project}", agentName, projectName);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "WS Proxy: upstream Verbindung fehlgeschlagen");
            if (clientSocket.State == WebSocketState.Open)
                await clientSocket.CloseAsync(WebSocketCloseStatus.InternalServerError,
                    "Upstream connection failed", CancellationToken.None);
            return;
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        await Task.WhenAny(
            RelayAsync(clientSocket, serverSocket, cts, "client→server"),
            RelayAsync(serverSocket, clientSocket, cts, "server→client"));
        cts.Cancel();
        // Kurz auf sauberes Schließen beider Relay-Tasks warten
        // (Ausnahmen ignorieren – Verbindungen sind bereits beendet)
    }

    private async Task RelayAsync(WebSocket source, WebSocket target,
        CancellationTokenSource cts, string direction)
    {
        var buffer = new byte[65536];
        try
        {
            while (!cts.IsCancellationRequested && source.State == WebSocketState.Open)
            {
                var result = await source.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
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
                        result.MessageType, result.EndOfMessage, cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "WS Proxy [{Direction}]: Relay-Fehler", direction);
        }
        finally { cts.Cancel(); }
    }
}
