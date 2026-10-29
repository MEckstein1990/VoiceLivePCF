using Dataverse.Client.Connection;
using Dataverse.Client.Mapping;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.PowerPlatform.Dataverse.Client;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;

namespace Dataverse.Client.Metadata;

/// <summary>
/// Gemeinsamer Speicher für Tabellen-Metadaten, getrennt nach Benutzer. Die Trennung ist nötig,
/// weil Dataverse je nach Rechten unterschiedliche Metadaten liefert.
/// </summary>
public sealed class MetadataStore : IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(30);
    public const int MaxEntries = 500;

    private readonly MemoryCache _cache = new(new MemoryCacheOptions { SizeLimit = MaxEntries });

    public async Task<T> GetAsync<T>(string sessionKey, string name, Func<Task<T>> load)
    {
        var key = $"{sessionKey}|{name}";

        if (_cache.TryGetValue(key, out Task<T>? cached) && cached is not null)
        {
            return await cached;
        }

        var loading = load();
        _ = _cache.Set(key, loading, new MemoryCacheEntryOptions { Size = 1, SlidingExpiration = Lifetime });

        try
        {
            return await loading;
        }
        catch
        {
            // Fehler (unbekannte Tabelle, fehlende Rechte, abgelaufenes Token) nicht dauerhaft cachen.
            _cache.Remove(key);
            throw;
        }
    }

    public void Dispose() => _cache.Dispose();
}

/// <summary>Zugriff auf die Metadaten im Kontext des aktuellen Aufrufers.</summary>
public sealed class MetadataCache(MetadataStore store, DataverseConnections connections, DataverseIdentity identity)
{
    public Task<EntityMetadata> GetAsync(string logicalName)
    {
        var name = logicalName.Trim().ToLowerInvariant();
        return store.GetAsync(identity.Key, name, () => LoadAsync(name));
    }

    /// <summary>
    /// Alle Tabellen, die der Aufrufer sieht. Das Laden (RetrieveAllEntities) dauert mehrere
    /// Sekunden, deshalb wird die Liste wie die Einzeltabellen je Benutzer gecacht. Gecacht werden
    /// nur Name und Anzeigename, nicht die vollen Metadaten.
    /// </summary>
    public Task<IReadOnlyList<TableInfo>> GetTablesAsync() =>
        // "*" kommt in keinem logischen Tabellennamen vor, kollidiert also nicht mit Einzeltabellen.
        store.GetAsync(identity.Key, "*tables", LoadTablesAsync);

    private async Task<IReadOnlyList<TableInfo>> LoadTablesAsync()
    {
        // Bewusst ohne CancellationToken: Das Ergebnis wird von mehreren Aufrufen geteilt und darf
        // nicht abbrechen, nur weil der erste Aufrufer die Verbindung beendet.
        var response = (RetrieveAllEntitiesResponse)await connections.GetService(identity).ExecuteAsync(
            new RetrieveAllEntitiesRequest { EntityFilters = EntityFilters.Entity, RetrieveAsIfPublished = true });

        return response.EntityMetadata
            .Select(e => new TableInfo(e.LogicalName, AttributeValueConverter.LabelText(e.DisplayName)))
            .ToList();
    }

    private async Task<EntityMetadata> LoadAsync(string logicalName)
    {
        var response = (RetrieveEntityResponse)await connections.GetService(identity).ExecuteAsync(new RetrieveEntityRequest
        {
            LogicalName = logicalName,
            EntityFilters = EntityFilters.Entity | EntityFilters.Attributes,
            RetrieveAsIfPublished = true,
        });

        return response.EntityMetadata;
    }
}

/// <summary>Logischer Name und Anzeigename einer Tabelle.</summary>
public sealed record TableInfo(string LogicalName, string? Label);

public static class EntityMetadataExtensions
{
    public static AttributeMetadata GetAttribute(this EntityMetadata table, string logicalName)
    {
        var attribute = table.Attributes.FirstOrDefault(a =>
            string.Equals(a.LogicalName, logicalName, StringComparison.OrdinalIgnoreCase));
        if (attribute is not null)
        {
            return attribute;
        }

        var suggestions = SuggestColumns(table, logicalName);
        throw new ArgumentException(
            $"Column '{logicalName}' does not exist in table '{table.LogicalName}'." +
            (suggestions.Count > 0 ? $" Did you mean: {string.Join(", ", suggestions)}?" : "") +
            " Alle Spalten liefert describe (Pfad tables/<Tabelle>).");
    }

    /// <summary>
    /// Ähnliche Spaltennamen, damit sich ein LLM nach einem geratenen Namen (z. B. address1_street1
    /// statt address1_line1) ohne zusätzlichen describe-Aufruf korrigieren kann.
    /// </summary>
    private static List<string> SuggestColumns(EntityMetadata table, string name, int max = 5)
    {
        name = name.ToLowerInvariant();
        var prefix = name.Split('_')[0];

        return table.Attributes
            .Where(a => a.AttributeOf is null)
            .Select(a => (a.LogicalName, Distance: Levenshtein(name, a.LogicalName)))
            .Where(c => c.Distance <= Math.Max(3, name.Length / 3)
                        || c.LogicalName.StartsWith(prefix + "_", StringComparison.Ordinal))
            .OrderBy(c => c.Distance)
            .Take(max)
            .Select(c => c.LogicalName)
            .ToList();
    }

    private static int Levenshtein(string a, string b)
    {
        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) previous[j] = j;

        for (var i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
            }

            (previous, current) = (current, previous);
        }

        return previous[b.Length];
    }
}
