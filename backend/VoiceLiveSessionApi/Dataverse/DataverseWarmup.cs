using Dataverse.Client.Connection;
using Dataverse.Client.Metadata;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.Dataverse;

/// <summary>
/// Wärmt beim Ausstellen des Session-Tokens die Caches des Benutzers vor, damit der erste
/// MCP-Aufruf im Gespräch nicht die Kaltstartkosten trägt (Verbindungsaufbau, Tabellenliste,
/// Schema der üblichen Tabellen). Welche Tabellen, steht in Dataverse:WarmupTables.
/// Läuft im Hintergrund; ein Fehler schadet nicht, der Aufruf lädt dann wie bisher selbst.
/// </summary>
public sealed class DataverseWarmup(
    IServiceProvider services,
    IConfiguration configuration,
    ILogger<DataverseWarmup> logger)
{
    public const string TablesSetting = "Dataverse:WarmupTables";

    public void Start(SessionTokenPayload payload)
    {
        // Der Resolver prüft beim Erzeugen die Dataverse-Konfiguration. Ohne sie soll das
        // Session-Token trotzdem funktionieren, daher erst hier auflösen.
        DataverseIdentity? identity;
        try
        {
            identity = services.GetRequiredService<DataverseIdentityResolver>().Resolve(payload);
        }
        catch (Exception ex)
        {
            logger.LogInformation(ex, "Dataverse: Vorwärmen übersprungen (nicht konfiguriert)");
            return;
        }

        if (identity is null)
            return;

        var tables = configuration.GetSection(TablesSetting).Get<string[]>() ?? [];

        _ = Task.Run(async () =>
        {
            try
            {
                await using var scope = services.CreateAsyncScope();
                scope.ServiceProvider.GetRequiredService<DataverseRequestContext>().Identity = identity;
                var metadata = scope.ServiceProvider.GetRequiredService<MetadataCache>();

                await Task.WhenAll(
                    metadata.GetTablesAsync(),
                    Task.WhenAll(tables.Select(metadata.GetAsync)));

                logger.LogInformation("Dataverse: Caches für {Key} vorgewärmt ({Tables})",
                    identity.Key, string.Join(", ", tables));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Dataverse: Vorwärmen für {Key} fehlgeschlagen", identity.Key);
            }
        });
    }
}
