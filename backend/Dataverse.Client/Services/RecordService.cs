using Dataverse.Client.Connection;
using Dataverse.Client.Mapping;
using Dataverse.Client.Metadata;
using Microsoft.PowerPlatform.Dataverse.Client;
using System.ComponentModel;
using System.Text.Json;

namespace Dataverse.Client.Services;

/// <summary>Ein Eintrag im Stapel von <c>update_record</c>.</summary>
public sealed record UpdateEntry(
    [property: Description("The GUID of the record id")] string RecordId,
    [property: Description("Properties to update as key-value pairs")] Dictionary<string, JsonElement> Item);

/// <summary>
/// Anlegen, Ändern und Löschen von Datensätzen — einzeln oder im Stapel.
/// <para>
/// Ein Stapel ist <b>keine</b> Transaktion: Teilfehler lassen den Aufruf nicht scheitern,
/// sondern erscheinen in der Ergebnisübersicht. Das ist Microsofts Verhalten und wird bewusst
/// übernommen.
/// </para>
/// </summary>
public sealed class RecordService(
    DataverseConnections connections,
    DataverseIdentity identity,
    MetadataCache metadata,
    EntityBuilder builder)
{
    public const int MaxBatchSize = 25;

    public async Task<string> CreateAsync(
        string tableName,
        Dictionary<string, JsonElement>? item = null,
        IReadOnlyList<Dictionary<string, JsonElement>>? items = null,
        CancellationToken cancellationToken = default)
    {
        var batch = RequireExactlyOne(item, items, "item", "items");
        var service = connections.GetService(identity);

        if (items is null)
        {
            var entity = await builder.BuildAsync(new RecordInput(tableName, batch[0]), isCreate: true);
            var id = await service.CreateAsync(entity, cancellationToken);
            return Json(new { table = entity.LogicalName, id });
        }

        return await RunBatchAsync(batch, async record =>
        {
            var entity = await builder.BuildAsync(new RecordInput(tableName, record), isCreate: true);
            return (object)new { id = await service.CreateAsync(entity, cancellationToken) };
        });
    }

    public async Task<string> UpdateAsync(
        string tableName,
        string? recordId = null,
        Dictionary<string, JsonElement>? item = null,
        IReadOnlyList<UpdateEntry>? records = null,
        CancellationToken cancellationToken = default)
    {
        var service = connections.GetService(identity);

        if (records is { Count: > 0 })
        {
            if (recordId is not null || item is not null)
            {
                throw new ArgumentException("Provide either 'recordId' + 'item' or 'records', not both.");
            }

            EnsureBatchSize(records.Count);

            return await RunBatchAsync(records, async entry =>
            {
                await ApplyUpdateAsync(service, tableName, entry.RecordId, entry.Item, cancellationToken);
                return (object)new { recordId = entry.RecordId };
            });
        }

        if (recordId is null || item is null)
        {
            throw new ArgumentException(
                "'recordId' and 'item' are required together (or 'records' for a batch).");
        }

        await ApplyUpdateAsync(service, tableName, recordId, item, cancellationToken);
        return Json(new { table = tableName, recordId, updatedColumns = item.Count });
    }

    public async Task<string> DeleteAsync(
        string tableName,
        bool hasUserApproved,
        string? recordId = null,
        IReadOnlyList<string>? recordIds = null,
        CancellationToken cancellationToken = default)
    {
        // Microsoft erzwingt die Rückfrage im Schema statt über die MCP-Annotation. Übernommen:
        // Eine Annotation ist ein Hinweis an den Client, ein Pflichtfeld bindet das Modell.
        if (!hasUserApproved)
        {
            throw new ArgumentException(
                "Deleting requires explicit user consent. Ask the user, then set 'hasUserApproved' to true.");
        }

        var ids = RequireExactlyOne(recordId, recordIds, "recordId", "recordIds");
        var meta = await metadata.GetAsync(tableName);
        var service = connections.GetService(identity);

        if (recordIds is null)
        {
            await service.DeleteAsync(meta.LogicalName, ParseId(ids[0]), cancellationToken);
            return Json(new { table = meta.LogicalName, recordId = ids[0], deleted = true });
        }

        return await RunBatchAsync(ids, async id =>
        {
            await service.DeleteAsync(meta.LogicalName, ParseId(id), cancellationToken);
            return (object)new { recordId = id };
        });
    }

    private async Task ApplyUpdateAsync(
        IOrganizationServiceAsync2 service,
        string table,
        string recordId,
        Dictionary<string, JsonElement> values,
        CancellationToken cancellationToken)
    {
        var entity = await builder.BuildAsync(new RecordInput(table, values), isCreate: false);
        entity.Id = ParseId(recordId);
        await service.UpdateAsync(entity, cancellationToken);
    }

    /// <summary>
    /// Führt einen Stapel aus und sammelt Erfolge wie Fehler je Eintrag ein. Ein einzelner
    /// Fehlschlag beendet den Stapel nicht — so verhält sich auch Microsofts Server.
    /// </summary>
    private static async Task<string> RunBatchAsync<T>(IReadOnlyList<T> entries, Func<T, Task<object>> run)
    {
        var results = new List<object>(entries.Count);
        var failed = 0;

        for (var index = 0; index < entries.Count; index++)
        {
            try
            {
                results.Add(new { index, success = true, result = await run(entries[index]) });
            }
            catch (Exception ex)
            {
                failed++;
                results.Add(new { index, success = false, error = ex.Message });
            }
        }

        return Json(new { total = entries.Count, succeeded = entries.Count - failed, failed, results });
    }

    private static IReadOnlyList<T> RequireExactlyOne<T>(
        T? single, IReadOnlyList<T>? batch, string singleName, string batchName)
        where T : class
    {
        if (single is not null && batch is { Count: > 0 })
        {
            throw new ArgumentException($"Provide either '{singleName}' or '{batchName}', not both.");
        }

        if (batch is { Count: > 0 })
        {
            EnsureBatchSize(batch.Count);
            return batch;
        }

        return single is not null
            ? [single]
            : throw new ArgumentException($"'{singleName}' or '{batchName}' is required.");
    }

    private static void EnsureBatchSize(int count)
    {
        if (count > MaxBatchSize)
        {
            throw new ArgumentException(
                $"A batch holds at most {MaxBatchSize} records (received: {count}).");
        }
    }

    private static Guid ParseId(string value) => Guid.TryParse(value, out var id)
        ? id
        : throw new ArgumentException($"'{value}' is not a valid GUID.");

    private static string Json(object value) => JsonSerializer.Serialize(value, JsonDefaults.Options);
}
