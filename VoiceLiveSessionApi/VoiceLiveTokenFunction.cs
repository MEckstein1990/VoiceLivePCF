using System.Net;
using Azure.Core;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi;

/// <summary>
/// Gibt ein kurzlebiges Azure-AI-Bearer-Token zurück (Scope: VOICE_LIVE_TOKEN_SCOPE),
/// das das PCF-Control als <c>agent-access-token</c> / <c>access_token</c>
/// für die Voice-Live-WebSocket-Verbindung im Agent-Modus benötigt.
///
/// Aufruf: GET /api/voice-live/token
///         Header: X-Proxy-Key: {PROXY_API_KEY}
///
/// Antwort: { "token": "eyJ...", "expiresOn": "2026-05-17T10:00:00.0000000+00:00", "scope": "https://ai.azure.com/.default" }
///
/// In Power Apps: Custom Connector → GET /api/voice-live/token → Ergebnis an PCF-Property Token binden.
/// </summary>
public sealed class VoiceLiveTokenFunction
{
    private readonly TokenCredential _credential;
    private readonly ILogger<VoiceLiveTokenFunction> _logger;
    private readonly string _scope;
    private readonly string? _proxyApiKey;

    public VoiceLiveTokenFunction(
        TokenCredential credential,
        ILogger<VoiceLiveTokenFunction> logger)
    {
        _credential = credential;
        _logger = logger;
        _scope = Environment.GetEnvironmentVariable("VOICE_LIVE_TOKEN_SCOPE")
            ?? "https://ai.azure.com/.default";
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
    }

    [Function("VoiceLiveToken")]
    public async Task<HttpResponseData> GetToken(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "options", Route = "voice-live/token")]
        HttpRequestData req,
        FunctionContext context)
    {
        // OPTIONS-Preflight wird von der Azure-Functions-Plattform (CORS-Whitelist) behandelt.
        // Fallback falls die Plattform es doch durchreicht:
        if (req.Method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            var preflight = req.CreateResponse(HttpStatusCode.NoContent);
            return preflight;
        }

        if (!IsProxyKeyValid(req))
        {
            var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
            await unauthorized.WriteStringAsync("Invalid proxy key.", context.CancellationToken);
            return unauthorized;
        }

        try
        {
            var tokenRequestContext = new TokenRequestContext([_scope]);
            var token = await _credential.GetTokenAsync(tokenRequestContext, context.CancellationToken);

            _logger.LogInformation(
                "Issued Voice Live token, scope={Scope}, expiresOn={ExpiresOn}",
                _scope,
                token.ExpiresOn);

            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate");
            await response.WriteAsJsonAsync(
                new
                {
                    token = token.Token,
                    expiresOn = token.ExpiresOn.ToString("O"),
                    scope = _scope,
                },
                context.CancellationToken);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to acquire Voice Live token for scope {Scope}", _scope);
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteStringAsync("Failed to acquire token.", context.CancellationToken);
            return error;
        }
    }

    private bool IsProxyKeyValid(HttpRequestData req)
    {
        // Wenn PROXY_API_KEY nicht konfiguriert ist, Zugriff erlauben (Dev/lokale Umgebung)
        if (string.IsNullOrEmpty(_proxyApiKey)) return true;
        req.Headers.TryGetValues("X-Proxy-Key", out var values);
        return values?.FirstOrDefault() == _proxyApiKey;
    }
}
