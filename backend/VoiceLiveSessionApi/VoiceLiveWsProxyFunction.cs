using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
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
    private readonly UserSessionStore _sessionStore;
    private readonly string _scope;
    private readonly string _voiceLiveEndpoint;
    private readonly string _apiVersion;
    private readonly string? _proxyApiKey;
    private readonly string? _dataverseMcpUrl;
    private readonly string[] _mcpAllowedTools;

    public VoiceLiveWsProxyFunction(
        TokenCredential credential,
        UserSessionStore sessionStore,
        ILogger<VoiceLiveWsProxyFunction> logger)
    {
        _credential = credential;
        _sessionStore = sessionStore;
        _logger = logger;
        _scope = Environment.GetEnvironmentVariable("VOICE_LIVE_TOKEN_SCOPE")
            ?? "https://ai.azure.com/.default";
        _voiceLiveEndpoint = Environment.GetEnvironmentVariable("VOICE_LIVE_ENDPOINT")
            ?? "https://test-speechlive-mcp.services.ai.azure.com";
        _apiVersion = Environment.GetEnvironmentVariable("VOICE_LIVE_API_VERSION")
            ?? "2026-04-10";
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
        _dataverseMcpUrl = Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL");
        var customTools = Environment.GetEnvironmentVariable("MCP_ALLOWED_TOOLS");
        _mcpAllowedTools = string.IsNullOrWhiteSpace(customTools)
            ? ["list_tables", "describe_table", "read_query", "create_record", "update_record"]
            : customTools.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
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

        var agentId = req.Query["agent-name"].FirstOrDefault()
            ?? req.Query["agent-id"].FirstOrDefault()
            ?? throw new ArgumentException("agent-name query param required");
        var projectName = req.Query["agent-project-name"].FirstOrDefault()
            ?? "proj-default";

        // User-Kontext: Dataverse SystemUser-GUID des eingeloggten Users.
        // Wird in der session.update-Nachricht in die Agenten-Instruktionen injiziert
        // und im UserSessionStore gespeichert, damit der MCP-Proxy die GUID nachschlagen kann.
        var callerId = req.Query["caller-id"].FirstOrDefault();
        var sessionId = !string.IsNullOrWhiteSpace(callerId)
            ? _sessionStore.CreateSession(callerId)
            : null;
        if (sessionId != null)
            _logger.LogInformation("WS Proxy: Session {SessionId} für User {CallerId} erstellt", sessionId, callerId);

        // UserContext mit User-GUID setzen (Teams/Accounts werden ohne Dataverse-API-Call nicht befüllt).
        // Die Filterlogik im DataverseMcpProxy greift trotzdem: ownerid = userId für alle Entitäten.
        if (!string.IsNullOrWhiteSpace(callerId))
            _sessionStore.SetCurrentUserContext(new UserContext(callerId, [], []));

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
        serverSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);

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
            // UserContext auch bei fehlgeschlagener Upstream-Verbindung löschen.
            if (!string.IsNullOrWhiteSpace(callerId))
                _sessionStore.SetCurrentUserContext(null);
            return;
        }

        // Bidirektionales Relay starten.
        // client→server: spezieller Relay der session.update abfängt und User-Kontext injiziert.
        // server→client: einfacher transparenter Relay.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(req.HttpContext.RequestAborted);
        var clientToServer = ClientToServerRelayAsync(clientSocket, serverSocket, cts, callerId);
        var serverToClient = RelayAsync(serverSocket, clientSocket, cts, "server→client");

        await Task.WhenAny(clientToServer, serverToClient);
        cts.Cancel();
        try { await Task.WhenAll(clientToServer, serverToClient).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch { /* Cleanup-Fehler ignorieren */ }

        if (sessionId != null)
            _sessionStore.RemoveSession(sessionId);

        // UserContext löschen damit keine veraltete GUID für nachfolgende MCP-Calls bleibt.
        if (!string.IsNullOrWhiteSpace(callerId))
            _sessionStore.SetCurrentUserContext(null);

        _logger.LogInformation("WS Proxy: Session beendet, Agent={AgentId}", agentId);
    }

    /// <summary>
    /// Client→Server Relay mit Auth-Interception, MCP-Tool-Injection und Instruktions-Injektion.
    /// Puffert vollständige WebSocket-Nachrichten und:
    ///   1. Fängt die erste Nachricht mit type=auth ab → speichert User-Token → leitet NICHT weiter.
    ///   2. Fängt session.update ab → injiziert MCP-Tool-Definition mit User-Token als Authorization
    ///      und User-Kontext in die Instruktionen.
    /// Alle anderen Nachrichten werden transparent weitergeleitet.
    /// </summary>
    private async Task ClientToServerRelayAsync(
        WebSocket source,
        WebSocket target,
        CancellationTokenSource cts,
        string? callerId)
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
                        _logger.LogInformation(
                            "WS Proxy [client→server]: Close empfangen – Status={CloseStatus}",
                            result.CloseStatus);
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
                // Wird vom PCF gesendet, bevor session.update kommt.
                // Token wird lokal gespeichert und die Nachricht NICHT an Voice Live weitergeleitet.
                if (userToken == null && result.MessageType == WebSocketMessageType.Text)
                {
                    var extractedToken = TryExtractAuthToken(payload);
                    if (extractedToken != null)
                    {
                        userToken = extractedToken;
                        _logger.LogInformation("WS Proxy: User-Token empfangen (Länge={TokenLength})", userToken.Length);
                        continue; // Nachricht schlucken – nicht an Voice Live weiterleiten
                    }
                }

                // Einmalig session.update abfangen: MCP-Tool + User-Kontext injizieren
                if (!injected && result.MessageType == WebSocketMessageType.Text)
                {
                    bool modified = false;

                    // Diagnose: session.update empfangen?
                    var msgJson = Encoding.UTF8.GetString(payload);
                    if (msgJson.Contains("\"session.update\""))
                        _logger.LogInformation(
                            "WS Proxy: session.update empfangen – userToken verfügbar={HasToken}",
                            !string.IsNullOrWhiteSpace(userToken));

                    // MCP-Tool mit User-Token als Authorization injizieren
                    if (!string.IsNullOrWhiteSpace(userToken) && !string.IsNullOrWhiteSpace(_dataverseMcpUrl))
                    {
                        var withMcp = TryInjectMcpTools(payload, userToken);
                        if (withMcp != null)
                        {
                            payload = withMcp;
                            modified = true;
                            _logger.LogInformation("WS Proxy: MCP-Tool mit User-Token in session.update injiziert");
                        }
                    }

                    // User-Kontext in Instruktionen injizieren (Defense-in-Depth)
                    if (!string.IsNullOrWhiteSpace(callerId))
                    {
                        var withContext = TryInjectUserContext(payload, callerId);
                        if (withContext != null)
                        {
                            payload = withContext;
                            modified = true;
                            _logger.LogInformation(
                                "WS Proxy: User-Kontext für {CallerId} in session.update injiziert", callerId);
                        }
                    }

                    if (modified)
                        injected = true;
                }

                if (target.State == WebSocketState.Open)
                    await target.SendAsync(
                        new ArraySegment<byte>(payload),
                        result.MessageType,
                        endOfMessage: true,
                        cts.Token);
            }
        }
        catch (OperationCanceledException) { /* Normales Beenden */ }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "WS Proxy [client→server]: Relay-Fehler");
        }
        finally
        {
            cts.Cancel();
        }
    }

    /// <summary>
    /// Extrahiert das User-Token aus einer Auth-Nachricht {type:"auth", token:"eyJ..."}.
    /// Gibt null zurück wenn die Nachricht keine Auth-Nachricht ist.
    /// </summary>
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

    /// <summary>
    /// Injiziert eine MCP-Tool-Definition mit dem User-Token als Authorization
    /// in die session.update-Nachricht. Voice Live ruft Dataverse MCP dann direkt
    /// mit dem User-Token an → Row-Level Security wird automatisch durchgesetzt.
    /// Gibt null zurück wenn die Nachricht kein session.update ist.
    /// </summary>
    private byte[]? TryInjectMcpTools(byte[] payload, string userToken)
    {
        try
        {
            var json = Encoding.UTF8.GetString(payload);
            var root = JsonNode.Parse(json) as JsonObject;
            if (root?["type"]?.GetValue<string>() != "session.update") return null;

            var session = root["session"] as JsonObject;
            if (session is null) return null;

            // Bestehende Tools beibehalten, MCP-Tool hinzufügen.
            // JsonArray kann nur einen Parent haben – deshalb bei existierendem Array
            // direkt dran appenden, bei fehlendem ein neues erstellen und zuweisen.
            var existingTools = session["tools"] as JsonArray;
            var tools = existingTools ?? new JsonArray();

            var allowedToolsArray = new JsonArray();
            foreach (var tool in _mcpAllowedTools)
                allowedToolsArray.Add(JsonValue.Create(tool));

            // ?_src=ws Marker: damit wir in DataverseMcpProxy-Logs sehen können ob Voice Live
            // die injizierte URL aufruft (statt der Agent-built-in URL ohne Marker).
            var injectedUrl = _dataverseMcpUrl!.Contains('?')
                ? _dataverseMcpUrl + "&_src=ws"
                : _dataverseMcpUrl + "?_src=ws";

            var mcpTool = new JsonObject
            {
                ["type"] = "mcp",
                ["server_label"] = "dataverse",
                ["server_url"] = injectedUrl,
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

    /// <summary>
    /// Fügt die Dataverse-User-GUID als Instruktion in eine session.update-Nachricht ein.
    /// Defense-in-Depth: Der Agent generiert SQL-Abfragen mit ownerid-Filter.
    /// Gibt null zurück wenn die Nachricht kein session.update ist oder das Parsen fehlschlägt.
    /// </summary>
    private static byte[]? TryInjectUserContext(byte[] payload, string callerId)
    {
        try
        {
            if (!Guid.TryParse(callerId, out _)) return null; // nur valide GUIDs

            var json = Encoding.UTF8.GetString(payload);
            var root = JsonNode.Parse(json) as JsonObject;
            if (root?["type"]?.GetValue<string>() != "session.update") return null;

            var session = root["session"] as JsonObject;
            if (session is null) return null;

            var existing = session["instructions"]?.GetValue<string>() ?? string.Empty;
            var userNote =
                $"\n\n[DATAVERSE-KONTEXT] Die Dataverse SystemUser-ID des aktuellen Nutzers lautet '{callerId}'. " +
                $"Füge bei ALLEN Dataverse-Abfragen (Tool read_query) einen WHERE-Filter hinzu: ownerid = '{callerId}'. " +
                "Gib niemals Datensätze anderer Nutzer zurück.";

            session["instructions"] = JsonValue.Create(existing + userNote);
            return Encoding.UTF8.GetBytes(root.ToJsonString());
        }
        catch { return null; }
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
                    _logger.LogInformation(
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
