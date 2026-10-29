using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace VoiceLiveSessionApi.Session;

/// <summary>Ergebnis einer erfolgreichen UserToken-Validierung.</summary>
public sealed record ValidatedUser(string ObjectId, string TenantId, DateTimeOffset ExpiresOn);

/// <summary>
/// Validiert Entra-ID-Access-Tokens (v1 und v2) gegen die OIDC-Metadaten des Tenants:
/// Signatur, Issuer, Audience und Ablaufzeit.
///
/// Konfiguration: TenantId und SessionToken:UserTokenAudiences (siehe <see cref="SessionTokenOptions"/>).
///
/// Hinweis: Microsoft-Graph-Tokens lassen sich nicht validieren (Signatur mit Nonce-Header)
/// und sind deshalb als Audience ungeeignet.
/// </summary>
public sealed class UserTokenValidator
{
    private readonly ConfigurationManager<OpenIdConnectConfiguration> _oidcConfig;
    private readonly JsonWebTokenHandler _handler = new();
    private readonly string _tenantId;
    private readonly string[] _audiences;

    public UserTokenValidator(IOptions<SessionTokenOptions> options)
    {
        var o = options.Value;
        _tenantId = !string.IsNullOrWhiteSpace(o.TenantId)
            ? o.TenantId
            : throw new InvalidOperationException("TenantId missing");
        _audiences = o.UserTokenAudiences.Count > 0
            ? [.. o.UserTokenAudiences]
            : throw new InvalidOperationException("SessionToken:UserTokenAudiences missing");

        // Lädt die Signaturschlüssel (JWKS) und cached sie; Key-Rollover wird automatisch nachgeladen.
        _oidcConfig = new ConfigurationManager<OpenIdConnectConfiguration>(
            $"https://login.microsoftonline.com/{_tenantId}/v2.0/.well-known/openid-configuration",
            new OpenIdConnectConfigurationRetriever(),
            new HttpDocumentRetriever { RequireHttps = true });
    }

    /// <summary>Gibt den validierten User zurück, oder null wenn das Token ungültig ist.</summary>
    public async Task<ValidatedUser?> ValidateAsync(string token, CancellationToken ct)
    {
        var config = await _oidcConfig.GetConfigurationAsync(ct);

        var result = await _handler.ValidateTokenAsync(token, new TokenValidationParameters
        {
            // v1-Tokens (sts.windows.net) und v2-Tokens (login.microsoftonline.com/v2.0) zulassen
            ValidIssuers =
            [
                $"https://login.microsoftonline.com/{_tenantId}/v2.0",
                $"https://sts.windows.net/{_tenantId}/"
            ],
            ValidAudiences = _audiences,
            IssuerSigningKeys = config.SigningKeys,
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ClockSkew = TimeSpan.FromMinutes(1)
        });

        if (!result.IsValid || result.SecurityToken is not JsonWebToken jwt)
            return null;

        // Nur User-Tokens akzeptieren: App-only-Tokens haben kein "scp"
        if (!jwt.TryGetPayloadValue<string>("oid", out var oid)
            || !jwt.TryGetPayloadValue<string>("scp", out _))
            return null;

        return new ValidatedUser(oid, _tenantId, new DateTimeOffset(jwt.ValidTo, TimeSpan.Zero));
    }
}
