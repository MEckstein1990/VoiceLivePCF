using Dataverse.Client.Connection;
using Dataverse.Client.Mapping;
using Dataverse.Client.Metadata;
using System.Text.Json;

namespace Dataverse.Client.Services;

/// <summary>
/// Dataverse SQL über den TDS-Endpunkt. Es wird bewusst <b>kein</b> SQL geprüft und keine
/// Positivliste geführt: Der Dienst lehnt Schreibzugriffe selbst ab, und seine tatsächlichen
/// Grenzen weichen von der Dokumentation ab (<c>DISTINCT</c> gilt als nicht unterstützt,
/// funktioniert aber). Eine eigene Prüfung wäre damit entweder zu streng oder unvollständig.
/// </summary>
public sealed class QueryService(DataverseConnections connections, DataverseIdentity identity)
{
    public const int DefaultRowLimit = 100;
    public const int MaxRowLimit = 1000;

    private const int QueryTimeoutSeconds = 60;

    public async Task<string> ReadQueryAsync(string queryText, int? top = null, CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(top ?? DefaultRowLimit, 1, MaxRowLimit);

        await using var connection = await connections.OpenSqlAsync(identity, cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = queryText;
        command.CommandTimeout = QueryTimeoutSeconds;

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        var rows = new List<Dictionary<string, object?>>();
        var truncated = false;

        while (await reader.ReadAsync(cancellationToken))
        {
            if (rows.Count == limit)
            {
                // Die Grenze wirkt unabhängig vom SQL-Text: Ein vergessenes TOP soll nicht das
                // Kontextfenster des Modells füllen.
                truncated = true;
                break;
            }

            var row = new Dictionary<string, object?>(reader.FieldCount);
            for (var i = 0; i < reader.FieldCount; i++)
            {
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }

            rows.Add(row);
        }

        return JsonSerializer.Serialize(
            new { rowCount = rows.Count, truncated, rows },
            JsonDefaults.Options);
    }
}
