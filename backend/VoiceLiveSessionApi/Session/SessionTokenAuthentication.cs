using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace VoiceLiveSessionApi.Session;

public static class SessionTokenAuthenticationDefaults
{
    public const string Scheme = "KoRaSessionToken";

    /// <summary>Policy für den WebSocket-Proxy /api/voice-live/ws.</summary>
    public const string VoiceLiveWsPolicy = "VoiceLiveWs";
}

/// <summary>
/// Hält den entschlüsselten Session-Payload für die Dauer des Requests.
/// Bewusst als Feature statt als Claims, damit das UserToken nicht im ClaimsPrincipal landet.
/// </summary>
public sealed class SessionTokenFeature(SessionTokenPayload payload)
{
    public SessionTokenPayload Payload { get; } = payload;
}

/// <summary>
/// Authentifiziert Requests mit einem Token aus /api/voice-live/token.
/// Token aus Query ?access_token= (Browser-WebSockets können keine Header setzen)
/// oder Header Authorization: Bearer.
/// </summary>
public sealed class SessionTokenAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    WebSocketTokenService webSocketTokens)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var token = ReadToken(Request);
        if (token is null)
            return Task.FromResult(AuthenticateResult.NoResult());

        var payload = webSocketTokens.Validate(token);
        if (payload is null)
            return Task.FromResult(AuthenticateResult.Fail("Invalid or expired session token"));

        Context.Features.Set(new SessionTokenFeature(payload));

        var claims = new List<Claim>
        {
            new("kora:agent", payload.AgentId),
            new("oid", payload.UserObjectId),
            new("tid", payload.TenantId)
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
    }

    private static string? ReadToken(HttpRequest request)
    {
        var header = request.Headers.Authorization.FirstOrDefault();
        if (header is not null && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return header["Bearer ".Length..].Trim();

        var query = request.Query["access_token"].FirstOrDefault();
        return string.IsNullOrWhiteSpace(query) ? null : query;
    }
}
