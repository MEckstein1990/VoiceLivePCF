using Dataverse.Client.Connection;
using Dataverse.Client.Mapping;
using Dataverse.Client.Metadata;
using Microsoft.PowerPlatform.Dataverse.Client;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using System.Text.Json;
using System.Text;

namespace Dataverse.Client.Services;

/// <summary>
/// Entdecken von Tabellen und Datensätzen: <see cref="SearchAsync"/> liefert Pfade,
/// <see cref="DescribeAsync"/> löst sie auf. Antwortformate wörtlich wie beim
/// Dataverse-MCP-Server von Microsoft.
/// </summary>
public sealed class DiscoveryService(
    DataverseConnections connections,
    DataverseIdentity identity,
    MetadataCache metadata)
{
    public async Task<string> SearchAsync(string query, int? limit = null, CancellationToken cancellationToken = default)
    {
        var tables = await metadata.GetTablesAsync();
        var term = query.Trim();

        var matches = tables
            .Where(e => Matches(e, term))
            // Treffer im LogicalName wiegen schwerer als solche im Anzeigenamen.
            .OrderByDescending(e => e.LogicalName.Contains(term, StringComparison.OrdinalIgnoreCase))
            .ThenBy(e => e.LogicalName, StringComparer.Ordinal)
            .Take(Math.Clamp(limit ?? 50, 1, 100))
            .ToList();

        if (matches.Count == 0)
        {
            return $"No results for '{query}'.";
        }

        var text = new StringBuilder();
        text.AppendLine($"Search results for '{query}':").AppendLine();
        text.AppendLine("**Schemas:**");

        foreach (var entity in matches)
        {
            text.AppendLine($"- `tables/{entity.LogicalName}` - {entity.Label ?? entity.LogicalName}");
        }

        return text.ToString();
    }

    public async Task<string> DescribeAsync(string path, CancellationToken cancellationToken = default)
    {
        var segments = path.Trim().Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);

        return segments switch
        {
            // "tables/" — ungefilterte Liste, wie bei Microsoft. Das Entdecken läuft über
            // SearchAsync, nicht über diese Liste.
            ["tables"] => await ListTablesAsync(cancellationToken),
            ["tables", var table] => TableSchemaFormatter.Format(await metadata.GetAsync(table)),
            ["tables", var table, "records", var id] => await DescribeRecordAsync(table, id, cancellationToken),
            _ => throw new ArgumentException(
                $"Path '{path}' is not supported. Supported paths: 'tables/', " +
                "'tables/{tablename}' and 'tables/{tablename}/records/{guid}'."),
        };
    }

    private async Task<string> ListTablesAsync(CancellationToken cancellationToken)
    {
        var tables = await metadata.GetTablesAsync();

        return string.Join(",", tables
            .Select(e => e.LogicalName)
            .OrderBy(name => name, StringComparer.Ordinal));
    }

    private async Task<string> DescribeRecordAsync(string table, string id, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(id, out var recordId))
        {
            throw new ArgumentException($"'{id}' is not a valid GUID.");
        }

        var meta = await metadata.GetAsync(table);
        var entity = await connections.GetService(identity)
            .RetrieveAsync(meta.LogicalName, recordId, new ColumnSet(true), cancellationToken);

        return JsonSerializer.Serialize(
            new
            {
                table = entity.LogicalName,
                id = entity.Id,
                attributes = entity.Attributes.ToDictionary(
                    a => a.Key, a => AttributeValueConverter.FromSdkValue(a.Value)),
                formattedValues = entity.FormattedValues.ToDictionary(f => f.Key, f => f.Value),
            },
            JsonDefaults.Options);
    }

    private static bool Matches(TableInfo table, string term) =>
        table.LogicalName.Contains(term, StringComparison.OrdinalIgnoreCase)
        || (table.Label?.Contains(term, StringComparison.OrdinalIgnoreCase) ?? false);
}

internal static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new() { WriteIndented = true };
}
