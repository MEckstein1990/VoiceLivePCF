using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
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
///
/// Interceptionen:
///   1. Auth-Message {type:"auth", token:"eyJ..."} → speichert User-Token, leitet NICHT weiter
///   2. session.update → injiziert MCP-Tool-Definition mit User-Token als Authorization
/// </summary>
internal sealed class VoiceLiveWsStartupFilter(
    TokenCredential credential,
    UserSessionStore sessionStore,
    ILoggerFactory loggerFactory) : IStartupFilter
{
    private readonly ILogger _log = loggerFactory.CreateLogger("VoiceLiveWsProxy");
 
    private readonly string? _dataverseMcpUrl = Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL");
    private readonly string[] _mcpAllowedTools = InitAllowedTools();
 
    private static string[] InitAllowedTools()
    {
        var customTools = Environment.GetEnvironmentVariable("MCP_ALLOWED_TOOLS");
        return string.IsNullOrWhiteSpace(customTools)
            ? ["list_tables", "describe_table", "read_query", "create_record", "update_record"]
            : customTools.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }
 
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseWebSockets(new Microsoft.AspNetCore.Builder.WebSocketOptions
            {
                KeepAliveInterval = TimeSpan.FromSeconds(30)
            });
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
        var callerId    = context.Request.Query["caller-id"].FirstOrDefault();
 
        // User-Kontext für SQL-Filter-Injektion im DataverseMcpProxy setzen.
        if (!string.IsNullOrWhiteSpace(callerId))
        {
            sessionStore.SetCurrentUserContext(new UserContext(callerId, [], []));
            _log.LogInformation("[FILTER-DIAG] UserContext gesetzt: callerId={CallerId}", callerId);
        }
        else
        {
            _log.LogWarning("[FILTER-DIAG] Kein caller-id in Query – Filter wird nicht greifen!");
        }
 
        var scope      = Environment.GetEnvironmentVariable("VOICE_LIVE_TOKEN_SCOPE")
                         ?? "https://ai.azure.com/.default";
        // Endpoint kann per Query-Param überschrieben werden (PCF sendet ihn), Fallback auf Env-Var.
        var endpoint   = context.Request.Query["endpoint"].FirstOrDefault()
                         ?? Environment.GetEnvironmentVariable("VOICE_LIVE_ENDPOINT")
                         ?? "https://foundry-enbw-KoRa-AI-sc.services.ai.azure.com";
        var apiVersion = Environment.GetEnvironmentVariable("VOICE_LIVE_API_VERSION")
                         ?? "2026-04-10";
 
        var tokenResult = await credential.GetTokenAsync(
            new TokenRequestContext([scope]), context.RequestAborted);
 
        var upstreamHost = new Uri(endpoint).Host;
        var encodedToken = Uri.EscapeDataString(tokenResult.Token);
        var targetUrl    = $"wss://{upstreamHost}/voice-live/realtime?api-version={apiVersion}" +
                           $"&agent-name={Uri.EscapeDataString(agentName)}" +
                           $"&agent-project-name={Uri.EscapeDataString(projectName)}" +
                           $"&agent-access-token={encodedToken}";
 
        var clientSocket = await context.WebSockets.AcceptWebSocketAsync();
 
        using var serverSocket = new ClientWebSocket();
        serverSocket.Options.SetRequestHeader("Authorization", $"Bearer {tokenResult.Token}");
        serverSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
 
        try
        {
            await serverSocket.ConnectAsync(new Uri(targetUrl), context.RequestAborted);
            _log.LogInformation("WS Proxy verbunden: agent={AgentName} project={Project}", agentName, projectName);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "WS Proxy: upstream Verbindung fehlgeschlagen");
            if (!string.IsNullOrWhiteSpace(callerId))
                sessionStore.SetCurrentUserContext(null);
            if (clientSocket.State == WebSocketState.Open)
                await clientSocket.CloseAsync(WebSocketCloseStatus.InternalServerError,
                    "Upstream connection failed", CancellationToken.None);
            return;
        }
 
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        var clientToServer = ClientToServerRelayAsync(clientSocket, serverSocket, cts, callerId);
        var serverToClient = RelayAsync(serverSocket, clientSocket, cts, "server→client");
 
        await Task.WhenAny(clientToServer, serverToClient);
        cts.Cancel();
        try { await Task.WhenAll(clientToServer, serverToClient).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch { /* Cleanup-Fehler ignorieren */ }
 
        // User-Kontext löschen damit keine veraltete GUID für nachfolgende MCP-Calls bleibt.
        if (!string.IsNullOrWhiteSpace(callerId))
            sessionStore.SetCurrentUserContext(null);
 
        _log.LogInformation("WS Proxy: Session beendet, Agent={AgentName}", agentName);
    }
 
    /// <summary>
    /// Client→Server Relay mit Auth-Interception und MCP-Tool-Injection.
    /// 1. Fängt {type:"auth", token:"eyJ..."} ab → speichert Token, leitet NICHT weiter
    /// 2. Fängt session.update ab → injiziert MCP-Tool mit User-Token als Authorization
    /// </summary>
    private async Task ClientToServerRelayAsync(
        WebSocket source, WebSocket target, CancellationTokenSource cts, string? callerId = null)
    {
        var buffer = new byte[65536];
        bool injected = false;
        string? userToken = null;
 
        try
        {
            while (!cts.IsCancellationRequested && source.State == WebSocketState.Open)
            {
                // Vollständige Nachricht puffern (kann aus mehreren Frames bestehen)
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await source.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _log.LogInformation("WS Proxy [client→server]: Close empfangen");
                        if (target.State == WebSocketState.Open)
                            await target.CloseAsync(
                                result.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                                result.CloseStatusDescription ?? string.Empty,
                                CancellationToken.None);
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
 
                var payload = ms.ToArray();
 
                // Auth-Message abfangen: {type:"auth", token:"eyJ..."}
                if (userToken == null && result.MessageType == WebSocketMessageType.Text)
                {
                    var extractedToken = TryExtractAuthToken(payload);
                    if (extractedToken != null)
                    {
                        userToken = extractedToken;
                        _log.LogInformation("WS Proxy: User-Token empfangen (Länge={Len})", userToken.Length);
                        continue; // Nachricht schlucken
                    }
                }
 
                // Einmalig session.update abfangen: MCP-Tool injizieren
                if (!injected && result.MessageType == WebSocketMessageType.Text
                    && !string.IsNullOrWhiteSpace(userToken) && !string.IsNullOrWhiteSpace(_dataverseMcpUrl))
                {
                    var withMcp = TryInjectMcpTools(payload, userToken, callerId);
                    if (withMcp != null)
                    {
                        payload = withMcp;
                        injected = true;
                        _log.LogInformation("WS Proxy: MCP-Tool mit User-Token in session.update injiziert");
                    }
                }
 
                if (target.State == WebSocketState.Open)
                    await target.SendAsync(
                        new ArraySegment<byte>(payload),
                        result.MessageType,
                        endOfMessage: true,
                        cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "WS Proxy [client→server]: Relay-Fehler");
        }
        finally { cts.Cancel(); }
    }
 
    private static string? TryExtractAuthToken(byte[] payload)
    {
        try
        {
            var json = Encoding.UTF8.GetString(payload);
            var root = JsonNode.Parse(json) as JsonObject;
            if (root?["type"]?.GetValue<string>() != "auth") return null;
            var token = root["token"]?.GetValue<string>();
            return string.IsNullOrWhiteSpace(token) ? null : token;
        }
        catch { return null; }
    }
 
    private byte[]? TryInjectMcpTools(byte[] payload, string userToken, string? callerId = null)
    {
        try
        {
            var json = Encoding.UTF8.GetString(payload);
            var root = JsonNode.Parse(json) as JsonObject;
            if (root?["type"]?.GetValue<string>() != "session.update") return null;
 
            var session = root["session"] as JsonObject;
            if (session is null) return null;
 
            var existingTools = session["tools"] as JsonArray;
            var tools = existingTools ?? new JsonArray();
 
            var allowedToolsArray = new JsonArray();
            foreach (var tool in _mcpAllowedTools)
                allowedToolsArray.Add(JsonValue.Create(tool));
 
            var mcpTool = new JsonObject
            {
                ["type"] = "mcp",
                ["server_label"] = "dataverse",
                ["server_url"] = string.IsNullOrWhiteSpace(callerId)
                    ? _dataverseMcpUrl
                    : $"{_dataverseMcpUrl}?caller-id={Uri.EscapeDataString(callerId)}",
                ["authorization"] = $"Bearer {userToken}",
                ["allowed_tools"] = allowedToolsArray,
                ["require_approval"] = "never"
            };
 
            tools.Add(mcpTool);
            if (existingTools is null)
                session["tools"] = tools;
 
            return Encoding.UTF8.GetBytes(root.ToJsonString());
        }
        catch { return null; }
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
                    _log.LogInformation(
                        "WS Proxy [{Direction}]: Close empfangen – Status={CloseStatus} Desc={CloseDescription}",
                        direction, result.CloseStatus, result.CloseStatusDescription);
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
 