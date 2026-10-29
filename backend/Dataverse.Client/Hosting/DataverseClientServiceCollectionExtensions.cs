using Dataverse.Client.Connection;
using Dataverse.Client.Mapping;
using Dataverse.Client.Metadata;
using Dataverse.Client.Services;

namespace Dataverse.Client.Hosting;

public static class DataverseClientServiceCollectionExtensions
{
    /// <summary>
    /// Registriert die Dataverse-Dienste (und damit alles, was <see cref="DataverseMcpTools"/>
    /// braucht). Woher Umgebung und Token kommen, entscheidet der Host über
    /// <paramref name="identity"/> – je Scope einmal aufgerufen, damit alle Beteiligten eines
    /// Aufrufs dieselbe Identität sehen.
    /// </summary>
    /// <param name="identity">Liefert die Identität des laufenden Aufrufs aus dessen Scope.</param>
    public static IServiceCollection AddDataverseClient(
        this IServiceCollection services,
        Func<IServiceProvider, DataverseIdentity> identity)
    {
        // Über alle Aufrufe geteilt; die Caches sind je Identität geschlüsselt.
        services.AddSingleton<DataverseClientCache>();
        services.AddSingleton<DataverseConnections>();
        services.AddSingleton<MetadataStore>();

        services.AddScoped(identity);

        services.AddScoped<MetadataCache>();
        services.AddScoped<EntityBuilder>();

        services.AddScoped<DiscoveryService>();
        services.AddScoped<QueryService>();
        services.AddScoped<RecordService>();

        return services;
    }
}
