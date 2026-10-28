namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>Abschnitt "Foundry" der Konfiguration: Beziehung dieser App zu Foundry.</summary>
public sealed class FoundryOptions
{
    public const string SectionName = "Foundry";

    /// <summary>
    /// Öffentliche Adresse dieser App, unter der Foundry den MCP-Server aufruft. Gegen sie werden die
    /// relativen Mcp:Url-Angaben der Ziele aufgelöst, z.B. Dev-Tunnel lokal oder Gateway/Custom Domain.
    /// Leer → https://WEBSITE_HOSTNAME (App Service).
    /// </summary>
    public string? McpCallbackBaseUrl { get; set; }
}
