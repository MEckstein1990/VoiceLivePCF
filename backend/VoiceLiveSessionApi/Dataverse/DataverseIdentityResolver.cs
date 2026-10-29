using Azure.Core;
using Dataverse.Client.Connection;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.Dataverse;

/// <summary>
/// Hält die Dataverse-Identität des laufenden Aufrufs (scoped). Wird von der
/// <see cref="DataverseMcpFunction"/> gesetzt; die Dienste aus Dataverse.Client
/// (QueryService, RecordService, …) bekommen sie per DI.
/// </summary>
public sealed class DataverseRequestContext
{
    public DataverseIdentity? Identity { get; set; }
}

/// <summary>
/// Ermittelt aus dem Bearer-Token eines MCP-Aufrufs, wie und in welcher Umgebung Dataverse
/// angesprochen wird.
///
/// Das Bearer-Token ist das MCP-Token (DataverseTokenService.Issue, ausgestellt von
/// der VoiceLiveSession, von Voice Live als Authorization-Header geschickt). Es ist der einzige
/// Vertrauensanker: Der Payload (Ziel, Org, User-Token, oid, tid) wurde beim Ausstellen des Session-Tokens geprüft,
/// ist authentifiziert verschlüsselt und läuft mit dem User-Token ab. Das User-Token wird hier
/// deshalb nicht erneut validiert. Ein Session-Token wird abgelehnt (anderer Purpose).
/// Die Org muss weiterhin zum Ziel in SessionToken:AllowedTargets gehören.
///
/// Die Audience des User-Tokens entscheidet über den Weg:
///   aud = Org des Ziels → Token ist schon ein Dataverse-Token, wird durchgereicht.
///   sonst               → Tausch per On-Behalf-Of.
/// Welche Audiences überhaupt vorkommen, begrenzt SessionToken:UserTokenAudiences beim Ausstellen des Session-Tokens;
/// ein Token für eine fremde App lehnt Entra beim OBO-Tausch ab.
/// </summary>
public sealed class DataverseIdentityResolver : IDisposable
{
    private enum TokenRoute { PassThrough, OnBehalfOf }

    private sealed record TokenSource(string UserToken, DataverseTokenProvider GetToken);

    private readonly DataverseTokenService _tokenService;
    private readonly SessionTargetPolicy _targets;
    private readonly DataverseAppCredentials _appCredentials;
    private readonly ILogger<DataverseIdentityResolver> _logger;
    private readonly string? _devToken;

    // Tokenquelle je Cache-Schlüssel. Ein zwischengespeicherter ServiceClient überlebt die
    // Anfrage, die ihn erzeugt hat – er holt sein Token deshalb hier über den Schlüssel ab und
    // bekommt so immer das zuletzt geprüfte User-Token, nicht das der ersten Anfrage.
    private readonly MemoryCache _tokenSources = new(new MemoryCacheOptions());

    public DataverseIdentityResolver(
        DataverseTokenService tokenService,
        SessionTargetPolicy targets,
        DataverseAppCredentials appCredentials,
        IOptions<DataverseAppOptions> options,
        ILogger<DataverseIdentityResolver> logger)
    {
        _tokenService = tokenService;
        _targets = targets;
        _appCredentials = appCredentials;
        _logger = logger;

        _devToken = options.Value.DevBearerToken;
    }

    /// <summary>Gibt die Identität des Aufrufers zurück, oder null wenn er nicht zugelassen ist (→ 401).</summary>
    public DataverseIdentity? Resolve(string? authorizationHeader)
    {
        var bearer = ReadBearerToken(authorizationHeader);
        var payload = bearer is null ? null : _tokenService.Validate(bearer);
        if (payload is null)
        {
            _logger.LogWarning("Dataverse: MCP-Token fehlt oder ist ungültig");
            return null;
        }

        return Resolve(payload);
    }

    /// <summary>
    /// Wie <see cref="Resolve(string?)"/>, aber für einen bereits geprüften Payload (z. B. direkt
    /// nach dem Ausstellen des Session-Tokens, um Caches vorzuwärmen).
    /// </summary>
    public DataverseIdentity? Resolve(SessionTokenPayload payload)
    {
        var (userToken, oid, tid) = (payload.UserToken, payload.UserObjectId, payload.TenantId);

        var target = _targets.FindTargetByName(payload.TargetName);
        var orgUrl = target is null ? null : SessionTargetPolicy.FindDataverseOrgUrl(target, payload.DataverseOrgUrl);
        if (orgUrl is null)
        {
            _logger.LogWarning("Dataverse: Ziel {Target} nicht (mehr) konfiguriert oder Org nicht erlaubt", payload.TargetName);
            return null;
        }

        // Nur lesen: Signatur und Ablauf sind durch das MCP-Token abgedeckt.
        var audience = new JsonWebToken(userToken).Audiences.FirstOrDefault() ?? "";
        var org = orgUrl.GetLeftPart(UriPartial.Authority);
        var route = string.Equals(audience.TrimEnd('/'), org, StringComparison.OrdinalIgnoreCase)
            ? TokenRoute.PassThrough
            : TokenRoute.OnBehalfOf;

        // Dev-Token: eine Identität für alle Aufrufer, daher ein gemeinsamer Schlüssel.
        var key = _devToken is not null ? $"dev-token|{org}" : $"{tid}|{oid}|{org}";
        RefreshTokenSource(key, userToken, route, orgUrl);

        return new DataverseIdentity(key, orgUrl, ct => GetTokenAsync(key, ct));
    }

    private void RefreshTokenSource(string key, string userToken, TokenRoute route, Uri orgUrl)
    {
        // Gleiches User-Token → vorhandene Quelle (und damit deren OBO-Cache) behalten.
        if (_tokenSources.TryGetValue(key, out TokenSource? existing) && existing!.UserToken == userToken)
            return;

        DataverseTokenProvider getToken = (_devToken, route) switch
        {
            ({ } devToken, _) => _ => Task.FromResult(devToken),
            (_, TokenRoute.PassThrough) => _ => Task.FromResult(userToken),
            _ => CreateOnBehalfOf(userToken, orgUrl)
        };

        _tokenSources.Set(key, new TokenSource(userToken, getToken),
            new MemoryCacheEntryOptions { SlidingExpiration = DataverseClientCache.Lifetime });
    }

    private DataverseTokenProvider CreateOnBehalfOf(string userToken, Uri orgUrl)
    {
        // Eine Credential-Instanz je User-Token: ihr Token-Cache spart den Tausch bei Entra.
        var credential = _appCredentials.CreateOnBehalfOf(userToken);
        var request = new TokenRequestContext([DataverseScopes.For(orgUrl)]);
        return async ct => (await credential.GetTokenAsync(request, ct)).Token;
    }

    private Task<string> GetTokenAsync(string key, CancellationToken ct)
        => _tokenSources.TryGetValue(key, out TokenSource? source)
            ? source!.GetToken(ct)
            : throw new InvalidOperationException(
                "Kein gültiges User-Token mehr für diese Dataverse-Verbindung. Bitte neu anmelden.");

    private static string? ReadBearerToken(string? header)
        => header is not null && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? header["Bearer ".Length..].Trim()
            : null;

    public void Dispose() => _tokenSources.Dispose();
}
