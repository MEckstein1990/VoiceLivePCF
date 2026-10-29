using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Ermittelt den MCP-Server eines Session-Ziels (Mcp:Url, Mcp:Label, Mcp:AllowedTools
/// aus SessionToken:AllowedTargets). Das Ziel wird je Verbindung über seinen Namen nachgeschlagen,
/// damit Konfigurationsänderungen auch für bereits ausgestellte Tokens gelten.
///
/// Das Ziel ist immer der eigene MCP-Server (/api/dataverse/mcp): Mcp:Url muss relativ sein
/// ("./api/…") und wird gegen die eigene öffentliche Adresse aufgelöst. Absolute URLs werden
/// abgelehnt, damit das MCP-Token nie an einen fremden Server geht.
/// Voice Live ruft den MCP-Server aus Azure auf – die Adresse muss also von dort erreichbar sein.
///   Foundry:McpCallbackBaseUrl – explizit, z.B. Dev-Tunnel lokal oder Gateway/Custom Domain
///   WEBSITE_HOSTNAME        – setzt App Service automatisch (z.B. func-voicelive-kora.azurewebsites.net)
/// </summary>
internal sealed class McpServerResolver(
    SessionTargetPolicy targetPolicy, IOptions<FoundryOptions> options, ILogger<McpServerResolver> log)
{
    private readonly Uri? _callbackBaseUrl = InitCallbackBaseUrl(options.Value.McpCallbackBaseUrl);

    private static Uri? InitCallbackBaseUrl(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured)
            && Environment.GetEnvironmentVariable("WEBSITE_HOSTNAME") is { Length: > 0 } hostName)
            configured = $"https://{hostName}";

        // Abschließender Slash, damit "./api/x" an die Basis angehängt statt dagegen ersetzt wird.
        return Uri.TryCreate(configured?.TrimEnd('/') + "/", UriKind.Absolute, out var uri) ? uri : null;
    }

    /// <summary>
    /// Null, wenn das Ziel nicht (mehr) erlaubt ist oder keine gültige HTTPS-URL hinterlegt ist.
    /// </summary>
    public McpServer? Resolve(string targetName)
    {
        var target = targetPolicy.FindTargetByName(targetName);
        if (target is null)
        {
            log.LogWarning("WS Proxy: Session-Ziel {Target} nicht (mehr) konfiguriert, kein MCP-Tool", targetName);
            return null;
        }

        if (string.IsNullOrWhiteSpace(target.Mcp.Url))
            return null;

        // Nur relative Angaben (./ oder /): Das Ziel ist immer der eigene MCP-Server.
        if (!target.Mcp.Url.StartsWith('.') && !target.Mcp.Url.StartsWith('/'))
        {
            log.LogWarning("WS Proxy: Mcp:Url von Ziel {Target} muss relativ sein (eigener MCP-Server), kein MCP-Tool", target.Name);
            return null;
        }

        if (_callbackBaseUrl is null)
        {
            log.LogWarning("WS Proxy: Mcp:Url von Ziel {Target} ist relativ, aber weder Foundry:McpCallbackBaseUrl noch WEBSITE_HOSTNAME ist gesetzt", target.Name);
            return null;
        }

        var uri = new Uri(_callbackBaseUrl, target.Mcp.Url);
        if (uri.Scheme == Uri.UriSchemeHttps)
            return new McpServer(uri.ToString(), target.Mcp.Label, target.Mcp.AllowedTools);

        log.LogWarning("WS Proxy: Mcp:Url von Ziel {Target} ergibt keine HTTPS-URL ({Url})", target.Name, uri);
        return null;
    }
}
