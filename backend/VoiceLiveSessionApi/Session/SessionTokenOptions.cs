namespace VoiceLiveSessionApi.Session;

/// <summary>
/// Konfiguration aus appsettings.json (Abschnitt "SessionToken").
/// Einzelwerte lassen sich per App-Setting überschreiben, z.B. SessionToken__AllowedTargets__0__AgentIds__0.
/// </summary>
public sealed class SessionTokenOptions
{
    public const string SectionName = "SessionToken";

    /// <summary>
    /// Tenant, in dem sich die Nutzer anmelden (Issuer und Signaturschlüssel des User-Tokens).
    /// Kommt aus dem gemeinsamen Top-Level-Wert "TenantId", nicht aus dem Abschnitt.
    /// </summary>
    public string? TenantId { get; set; }

    /// <summary>
    /// Erlaubte "aud"-Werte des User-Tokens, z.B. "api://kora-voicelive" oder die Dataverse-Org.
    /// Microsoft-Graph-Tokens lassen sich nicht validieren und sind als Audience ungeeignet.
    /// </summary>
    public List<string> UserTokenAudiences { get; set; } = [];

    public List<SessionTarget> AllowedTargets { get; set; } = [];
}

/// <summary>
/// Eine erlaubte Kombination aus Agent und Dataverse-Org.
/// <see cref="Name"/> muss eindeutig sein: Er landet im Session-Token, und der WS-Proxy
/// findet das Ziel darüber wieder.
/// </summary>
public sealed class SessionTarget
{
    public string Name { get; set; } = string.Empty;
    public string AgentEndpoint { get; set; } = string.Empty;
    public string AgentProjectName { get; set; } = string.Empty;
    public List<string> AgentIds { get; set; } = [];
    public List<string> DataverseOrgUrls { get; set; } = [];

    /// <summary>MCP-Server, den der WS-Proxy für dieses Ziel in session.update einträgt.</summary>
    public McpServerSettings Mcp { get; set; } = new();
}

/// <summary>Der eigene MCP-Server, den Voice Live für ein Ziel aufruft.</summary>
public sealed class McpServerSettings
{
    /// <summary>
    /// Immer der eigene MCP-Server: relativ (z.B. "./api/dataverse/mcp"), aufgelöst gegen die
    /// öffentliche Adresse (Foundry:McpCallbackBaseUrl, sonst https://WEBSITE_HOSTNAME/).
    /// Absolute URLs werden abgelehnt. Leer → kein MCP-Tool.
    /// </summary>
    public string? Url { get; set; }

    /// <summary>"server_label" des MCP-Tools in Voice Live.</summary>
    public string Label { get; set; } = "dataverse";

    /// <summary>
    /// Tools des MCP-Servers, die Voice Live aufrufen darf ("allowed_tools").
    /// Leer → kein Filter, Voice Live sieht alle Tools des Servers.
    /// </summary>
    public List<string> AllowedTools { get; set; } = [];
}

/// <summary>
/// Prüft, ob eine Request-Kombination in den AllowedTargets steht.
/// Ohne Einträge wird alles abgelehnt.
/// </summary>
public sealed class SessionTargetPolicy
{
    private readonly IReadOnlyList<SessionTarget> _targets;

    public SessionTargetPolicy(Microsoft.Extensions.Options.IOptions<SessionTokenOptions> options)
    {
        _targets = options.Value.AllowedTargets;

        if (_targets.Any(t => string.IsNullOrWhiteSpace(t.Name)))
            throw new InvalidOperationException("SessionToken:AllowedTargets: jedes Ziel braucht einen Name.");

        var duplicates = _targets.GroupBy(t => t.Name, StringComparer.Ordinal)
            .Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        if (duplicates.Count > 0)
            throw new InvalidOperationException(
                $"SessionToken:AllowedTargets: Name muss eindeutig sein, doppelt: {string.Join(", ", duplicates)}");
    }

    /// <summary>Ziel mit diesem Namen, oder null wenn es (nicht mehr) konfiguriert ist.</summary>
    public SessionTarget? FindTargetByName(string? name)
        => name is null ? null : _targets.FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.Ordinal));

    /// <summary>Gibt das passende Ziel zurück, oder null wenn die Kombination nicht erlaubt ist.</summary>
    public SessionTarget? FindTarget(
        string agentEndpoint, string agentProjectName, string agentId, string dataverseOrgUrl)
    {
        var endpoint = NormalizeUrl(agentEndpoint);
        var orgUrl = NormalizeUrl(dataverseOrgUrl);
        if (endpoint is null || orgUrl is null)
            return null;

        return _targets.FirstOrDefault(t =>
            NormalizeUrl(t.AgentEndpoint) == endpoint
            && string.Equals(t.AgentProjectName, agentProjectName, StringComparison.Ordinal)
            && t.AgentIds.Contains(agentId, StringComparer.Ordinal)
            && t.DataverseOrgUrls.Any(u => NormalizeUrl(u) == orgUrl));
    }

    /// <summary>
    /// Gibt die normalisierte Org-URL zurück, wenn sie in diesem Ziel als DataverseOrgUrl
    /// erlaubt ist, sonst null.
    /// </summary>
    public static Uri? FindDataverseOrgUrl(SessionTarget target, string? dataverseOrgUrl)
    {
        var orgUrl = dataverseOrgUrl is null ? null : NormalizeUrl(dataverseOrgUrl);
        if (orgUrl is null)
            return null;

        return target.DataverseOrgUrls.Any(u => NormalizeUrl(u) == orgUrl)
            ? new Uri(orgUrl)
            : null;
    }

    /// <summary>
    /// Reduziert eine URL auf "https://host[:port]/pfad" mit Host in Kleinbuchstaben, ohne
    /// abschließenden Slash, Query und Fragment. Nicht-HTTPS-URLs und URLs mit Userinfo → null.
    /// </summary>
    private static string? NormalizeUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo))
            return null;

        // Uri.GetLeftPart(Authority) liefert Schema und Host bereits in Kleinbuchstaben
        return uri.GetLeftPart(UriPartial.Authority) + uri.AbsolutePath.TrimEnd('/');
    }
}
