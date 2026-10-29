using Dataverse.Client;
using Dataverse.Client.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace VoiceLiveSessionApi.Dataverse;

public static class DataverseServiceCollectionExtensions
{
    /// <summary>
    /// Registriert Dataverse.Client samt MCP-Server. Umgebung und Token kommen je Aufruf aus dem
    /// <see cref="DataverseIdentityResolver"/>; die <see cref="DataverseMcpFunction"/> legt das
    /// Ergebnis im <see cref="DataverseRequestContext"/> ab, bevor die MCP-Tools Dienste daraus
    /// auflösen.
    /// Setzt AddSessionToken (WebSocketTokenService, DataverseTokenService, SessionTargetPolicy) und einen
    /// <see cref="Azure.Core.TokenCredential"/> (Key-Vault-Zugriff) voraus.
    /// </summary>
    public static IServiceCollection AddDataverse(this IServiceCollection services)
    {
        // Geprüft beim ersten Zugriff (erster MCP-Aufruf), nicht beim Start – ohne Dataverse-
        // Konfiguration laufen Session-Token und WS-Proxy weiter.
        services.AddOptions<DataverseAppOptions>()
            .BindConfiguration(DataverseAppOptions.SectionName)
            .Configure<IConfiguration>((o, config) => o.TenantId = config["TenantId"])
            .PostConfigure(o => o.DevBearerToken = o.DevBearerToken?.Trim() is { Length: > 0 } token ? token : null)
            .Validate(o => !string.IsNullOrWhiteSpace(o.TenantId), "TenantId fehlt.")
            .Validate(o => !string.IsNullOrWhiteSpace(o.ClientId), "Dataverse:ClientId fehlt.")
            .Validate(o => o.HasCredential,
                "Weder Dataverse:CertificateKeyVaultUrl/-Name noch Dataverse:CertificateBase64 " +
                "noch Dataverse:CertificatePath noch Dataverse:ClientSecret gesetzt.");
        services.AddSingleton<DataverseAppCredentials>();

        services.AddSingleton<DataverseIdentityResolver>();
        services.AddSingleton<DataverseWarmup>();

        // Je Aufruf einmal ermittelt und dann durchgereicht — so sehen alle Beteiligten
        // dieselbe Identität.
        services.AddScoped<DataverseRequestContext>();
        services.AddDataverseClient(sp => sp.GetRequiredService<DataverseRequestContext>().Identity
            ?? throw new InvalidOperationException(
                "Keine Dataverse-Identität. Nur innerhalb der DataverseMcpFunction verfügbar."));

        // Nur Optionen und Tools – den Transport baut die DataverseMcpFunction je Request.
        services.AddMcpServer(options =>
            {
                options.ServerInfo = new() { Name = "kora-dataverse", Version = "1.0.0" };
                // Tools im Scope der Function-Invocation erzeugen, dort ist der Aufrufer gesetzt.
                options.ScopeRequests = false;
            })
            .WithTools<DataverseMcpTools>();

        return services;
    }
}
