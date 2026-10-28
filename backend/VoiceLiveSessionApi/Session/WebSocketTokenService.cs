using Microsoft.AspNetCore.DataProtection;

namespace VoiceLiveSessionApi.Session;

/// <summary>
/// Token, mit dem sich der Client am WebSocket-Proxy anmeldet (Scope <c>KoRa.Websockets.v1</c>).
/// Es wird von /api/voice-live/token ausgestellt und geht an den Client. Vom Dataverse-Endpunkt
/// wird es abgelehnt, siehe <see cref="DataverseTokenService"/>.
/// </summary>
public sealed class WebSocketTokenService(IDataProtectionProvider provider)
    : ScopedTokenService(provider, "KoRa.Websockets.v1")
{
    /// <summary>Erstellt ein Token, das bis <paramref name="expiresOn"/> (Ablauf des User-Tokens) gilt.</summary>
    public string Issue(SessionTokenPayload payload, DateTimeOffset expiresOn) => Protect(payload, expiresOn);

    /// <summary>Payload des Tokens, oder null wenn es manipuliert, fremd oder abgelaufen ist.</summary>
    public SessionTokenPayload? Validate(string token) => Unprotect(token);
}
