using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using VoiceLiveSessionApi.Dataverse;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi.Session;

public sealed record SessionTokenRequest(
    string? AgentEndpoint,
    string? AgentProjectName,
    string? AgentId,
    string? DataverseOrgUrl);

/// <summary>
/// Tauscht ein Entra-User-Token plus Agent-Parameter gegen ein Session-Token, das der
/// WebSocket-Proxy /api/voice-live/ws prüft. Das Session-Token gilt bis zum Ablauf des
/// User-Tokens.
///
/// POST /api/voice-live/token
///   Authentifizierung: Header Authorization: Bearer &lt;Entra-JWT&gt;, geprüft vom UserTokenValidator.
///   Das Bearer-Token ist das User-Token: Es wird verschlüsselt im Session-Token abgelegt und
///   später als Grundlage für den Dataverse-Zugriff benutzt.
///   Body: { AgentEndpoint, AgentProjectName, AgentId, DataverseOrgUrl }
///   → { access_token, token_type: "Bearer", expires_in, endpoint: "wss://&lt;host&gt;/api/voice-live/ws" }
///
/// Erlaubte Kombinationen aus AgentEndpoint, AgentProjectName, AgentId und DataverseOrgUrl
/// stehen in SessionToken:AllowedTargets (appsettings.json); alles andere → 403.
/// </summary>
public sealed class SessionTokenFunction
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly UserTokenValidator _userTokenValidator;
    private readonly WebSocketTokenService _webSocketTokens;
    private readonly ILogger<SessionTokenFunction> _logger;
    private readonly SessionTargetPolicy _targetPolicy;
    private readonly DataverseWarmup _warmup;

    public SessionTokenFunction(
        UserTokenValidator userTokenValidator,
        WebSocketTokenService webSocketTokens,
        SessionTargetPolicy targetPolicy,
        DataverseWarmup warmup,
        ILogger<SessionTokenFunction> logger)
    {
        _userTokenValidator = userTokenValidator;
        _webSocketTokens = webSocketTokens;
        _targetPolicy = targetPolicy;
        _warmup = warmup;
        _logger = logger;
    }

    [Function("SessionToken")]
    public async Task<HttpResponseData> Run(
        // Anonymous: Die Authentifizierung ist das Entra-Token im Authorization-Header,
        // nicht der Function Key.
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "voice-live/token")]
        HttpRequestData req,
        FunctionContext context)
    {
        var userToken = ReadBearerToken(req);
        var user = userToken is null
            ? null
            : await _userTokenValidator.ValidateAsync(userToken, context.CancellationToken);
        if (userToken is null || user is null)
        {
            _logger.LogWarning("SessionToken: Bearer-Token fehlt oder ist ungültig");
            var unauthorized = await TextResponse(req, HttpStatusCode.Unauthorized, "Unauthorized");
            unauthorized.Headers.Add("WWW-Authenticate", "Bearer");
            return unauthorized;
        }

        SessionTokenRequest? body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<SessionTokenRequest>(req.Body, JsonOptions);
        }
        catch (JsonException)
        {
            return await TextResponse(req, HttpStatusCode.BadRequest, "Invalid JSON");
        }

        if (body is null
            || string.IsNullOrWhiteSpace(body.AgentEndpoint)
            || string.IsNullOrWhiteSpace(body.AgentProjectName)
            || string.IsNullOrWhiteSpace(body.AgentId)
            || string.IsNullOrWhiteSpace(body.DataverseOrgUrl))
        {
            return await TextResponse(req, HttpStatusCode.BadRequest,
                "AgentEndpoint, AgentProjectName, AgentId und DataverseOrgUrl sind erforderlich");
        }

        // Kombination gegen SessionToken:AllowedTargets prüfen: sonst könnte ein Aufrufer das Backend
        // dazu bringen, Tokens an einen fremden Server zu schicken.
        var target = _targetPolicy.FindTarget(
            body.AgentEndpoint, body.AgentProjectName, body.AgentId, body.DataverseOrgUrl);
        if (target is null)
        {
            _logger.LogWarning("SessionToken: Kombination nicht erlaubt ({AgentEndpoint}, {AgentProjectName}, {AgentId}, {DataverseOrgUrl})",
                body.AgentEndpoint, body.AgentProjectName, body.AgentId, body.DataverseOrgUrl);
            return await TextResponse(req, HttpStatusCode.Forbidden, "Target not allowed");
        }

        var payload = new SessionTokenPayload(
            target.Name,
            body.AgentEndpoint,
            body.AgentProjectName,
            body.AgentId,
            body.DataverseOrgUrl,
            userToken,
            user.ObjectId,
            user.TenantId);
        var token = _webSocketTokens.Issue(payload, user.ExpiresOn);

        // Bis das Gespräch beginnt, ist die Dataverse-Verbindung des Benutzers schon aufgebaut.
        _warmup.Start(payload);

        var expiresOn = user.ExpiresOn;
        _logger.LogInformation("SessionToken: Token für Ziel {Target} ausgestellt (User {Oid}), gültig bis {ExpiresOn}",
            target.Name, user.ObjectId, expiresOn);

        // Das Control kennt den Host des Backends nicht, es bekommt ihn zusammen mit dem Token. So bekommt der
        // Host, der das Token ausgestellt hat, es auch zurück.
        var endpoint = $"wss://{req.Url.Authority}/api/voice-live/ws";

        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Cache-Control", "no-store");
        await response.WriteAsJsonAsync(new
        {
            access_token = token,
            token_type = "Bearer",
            expires_in = (int)Math.Max(0, (expiresOn - DateTimeOffset.UtcNow).TotalSeconds),
            endpoint
        });
        return response;
    }

    private static string? ReadBearerToken(HttpRequestData req)
    {
        if (!req.Headers.TryGetValues("Authorization", out var values))
            return null;

        var header = values.FirstOrDefault();
        return header is not null && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? header["Bearer ".Length..].Trim()
            : null;
    }

    private static async Task<HttpResponseData> TextResponse(HttpRequestData req, HttpStatusCode status, string message)
    {
        var response = req.CreateResponse(status);
        await response.WriteStringAsync(message);
        return response;
    }
}
