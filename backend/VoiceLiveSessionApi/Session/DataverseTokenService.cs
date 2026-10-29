using Microsoft.AspNetCore.DataProtection;
using Microsoft.IdentityModel.JsonWebTokens;

namespace VoiceLiveSessionApi.Session;

/// <summary>
/// Token, das Voice Live als "authorization" an den Dataverse-MCP-Endpunkt schickt
/// (Scope <c>KoRa.Mcp.Dataverse.v1</c>). Es entsteht erst im WS-Proxy, der Client sieht es nie.
/// Derselbe Payload wie beim WebSocket-Token, aber anderer Scope: Das Token des Clients öffnet
/// keinen Dataverse-Aufruf, und dieses Token öffnet keinen WebSocket.
/// </summary>
public sealed class DataverseTokenService(IDataProtectionProvider provider)
    : ScopedTokenService(provider, "KoRa.Mcp.Dataverse.v1")
{
    /// <summary>
    /// Gültig bis zum Ablauf des UserTokens (wie das WebSocket-Token).
    /// Ist das UserToken nicht lesbar oder schon abgelaufen → null.
    /// </summary>
    public string? Issue(SessionTokenPayload payload)
    {
        DateTimeOffset expiresOn;
        try
        {
            // Nur "exp" lesen: das UserToken wurde beim Ausstellen des WebSocket-Tokens bereits vollständig validiert.
            expiresOn = new DateTimeOffset(new JsonWebToken(payload.UserToken).ValidTo, TimeSpan.Zero);
        }
        catch (ArgumentException)
        {
            return null;
        }

        return expiresOn > DateTimeOffset.UtcNow ? Protect(payload, expiresOn) : null;
    }

    /// <summary>Payload des Tokens, oder null wenn es manipuliert, fremd (anderer Scope) oder abgelaufen ist.</summary>
    public SessionTokenPayload? Validate(string token) => Unprotect(token);
}
