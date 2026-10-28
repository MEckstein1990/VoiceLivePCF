using Dataverse.Client.Connection;
using Dataverse.Client.Hosting;
using Dataverse.Client.Services;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using ModelContextProtocol.Server;
using System.ComponentModel;
using System.Text.Json;

namespace Dataverse.Client;

/// <summary>
/// Die Dataverse-Werkzeuge als MCP-Tools. Reine Weiterleitungen an die Dienste; Schema und
/// Argumente erzeugt das MCP-SDK aus den Signaturen – Parameternamen sind deshalb Teil des
/// Vertrags. Ein Host bindet sie mit <c>AddMcpServer().WithTools&lt;DataverseMcpTools&gt;()</c>
/// ein und stellt per DI die <see cref="DataverseIdentity"/> des Aufrufers bereit.
/// <para>
/// Namen und Beschreibungen sind keine Dokumentation, sondern Steuerung: Ein Modell entscheidet
/// anhand von ihnen, welches Werkzeug es wählt und wie es die Parameter füllt. Sie stammen
/// wörtlich vom Dataverse-MCP-Server von Microsoft (erhoben 2026-10-12, siehe
/// <c>docs/reference/ms-dataverse-mcp-tools.json</c>) — davon abweichen heißt, die
/// Austauschbarkeit aufzugeben. Ausnahme: <c>whoami</c> ist unser Diagnose-Tool.
/// </para>
/// </summary>
[McpServerToolType]
public sealed class DataverseMcpTools(
    DataverseIdentity identity,
    DataverseConnections connections,
    DiscoveryService discovery,
    QueryService queryService,
    RecordService recordService)
{
    private const string UnusedScope = "Optional. Not used by this server; accepted for compatibility.";

    [McpServerTool(Name = "whoami")]
    [Description("Gibt den Dynamics-Benutzer zurück, als der dieser Aufruf in Dataverse ankommt: " +
                 "Name, Anmeldename, E-Mail, Entra-Object-ID, systemuserid und Business Unit.")]
    public Task<string> WhoAmI(CancellationToken ct)
        => ToolErrors.GuardAsync(async () =>
        {
            var service = connections.GetService(identity);
            var who = (WhoAmIResponse)await service.ExecuteAsync(new WhoAmIRequest(), ct);
            var user = await service.RetrieveAsync("systemuser", who.UserId,
                new ColumnSet("fullname", "domainname", "internalemailaddress", "azureactivedirectoryobjectid"), ct);

            return $"name={user.GetAttributeValue<string>("fullname") ?? "-"}, " +
                   $"user={user.GetAttributeValue<string>("domainname") ?? "-"}, " +
                   $"mail={user.GetAttributeValue<string>("internalemailaddress") ?? "-"}, " +
                   $"oid={user.GetAttributeValue<Guid?>("azureactivedirectoryobjectid")?.ToString() ?? "-"}, " +
                   $"systemuserid={who.UserId}, businessunitid={who.BusinessUnitId}, org={identity.Url.Host}";
        });

    [McpServerTool(Name = "search")]
    [Description(
        "Find table schemas in Dataverse by keyword. Returns filesystem-style paths: " +
        "tables/{tablename}. Use describe() on returned paths to see full details.")]
    public Task<string> Search(
        [Description("Search keywords or phrase")] string query,
        [Description("Max results to return (default: 50, max: 100)")] int? limit = null,
        [Description(UnusedScope)] string? scope = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => discovery.SearchAsync(query, limit, ct));

    [McpServerTool(Name = "describe")]
    [Description(
        "Get comprehensive details for any path from search(). Path formats: " +
        "tables/ (list all tables), tables/{tablename} (table schema with fields, types " +
        "and options), tables/{tablename}/records/{guid} (full record).")]
    public Task<string> Describe(
        [Description("Path from search() results, e.g. tables/, tables/account, tables/account/records/{guid}")]
            string path,
        [Description(UnusedScope)] string? scope = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => discovery.DescribeAsync(path, ct));

    [McpServerTool(Name = "read_query")]
    [Description("""
        Dataverse SQL supports only basic SELECT queries with an explicit list of selected fields.
        If aggregates are used, do not mix aggregated and non-aggregated columns in the SELECT list without a GROUP BY clause.
        If a query requires comparing to an aggregate (for example, > AVG), do not use subqueries.
        Instead, split the logic into two queries: one to compute the aggregate and another to filter using literal values.
        GETDATE() and GETUTCDATE() functions are supported in predicates but not in the SELECT list.
        The following features are allowed:

        TOP (without OFFSET). Example: SELECT TOP 20 col1 FROM table1
        Simple column-to-literal, column-to-column and column-to-date value function WHERE filters.
        ORDER BY. Example: SELECT col1, age FROM table1 ORDER BY age
        GROUP BY. Only the following aggregates are supported: COUNT, SUM, AVG, MIN, MAX.
        JOINs. Example: SELECT t1.col1, t2.col1 FROM table1 t1 JOIN table2 t2 ON t1.col1 = t2.col1

        The following features are NOT supported:

        Subqueries (in SELECT, WHERE, FROM), HAVING, WITH, OFFSET, UNION, CAST, CONVERT, CASE,
        IF-ELSE, ROUND, date functions such as DATEDIFF/DATEADD, and JOINs on aggregates.
        """)]
    public Task<string> ReadQuery(
        [Description(
            "The SELECT SQL query to execute. Use search() to locate the table's schema path, " +
            "then describe() to get column names and types.")]
            string querytext,
        [Description("Optional. Maximum number of records to return. Defaults to 100.")] int? top = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => queryService.ReadQueryAsync(querytext, top, ct));

    [McpServerTool(Name = "create_record")]
    [Description(
        "INSERT one or more rows into a table in the Dataverse database. Provide 'item' to " +
        "create a single record (returns the created record's GUID), or 'items' (an array of " +
        "objects) to create multiple records in one call (returns a per-record result summary - " +
        "check it for per-record failures, which do not fail the call itself). Call describe " +
        "first if the table's schema is unknown - DO NOT guess column logical names from " +
        "display names. Choice columns require numeric option values, not labels.")]
    public Task<string> CreateRecord(
        [Description("The logical (schema) name of table to insert into.")] string tablename,
        [Description(
            "Record field values as key-value pairs for a SINGLE record. For lookup fields use an " +
            "object: {\"relatedTable\": \"account\", \"recordId\": \"<guid>\"}. For choice fields use " +
            "the numeric option value.")]
            Dictionary<string, JsonElement>? item = null,
        [Description(
            "Batch create: an array of record objects (maximum 25). Each element has the same shape " +
            "as 'item'. Provide either 'item' or 'items', not both.")]
            List<Dictionary<string, JsonElement>>? items = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => recordService.CreateAsync(tablename, item, items, ct));

    [McpServerTool(Name = "update_record")]
    [Description(
        "UPDATE one or more rows in a table in the Dataverse database. Provide 'recordId' and " +
        "'item' to update a single record, or 'records' (an array of {recordId, item} objects) " +
        "to update multiple records in one call. Columns not named stay unchanged; null clears " +
        "a column (not allowed for required columns).")]
    public Task<string> UpdateRecord(
        [Description("The logical name (schema name) of the table to update a record in.")] string tablename,
        [Description("The GUID of the single record to update. Provide together with 'item'.")] string? recordId = null,
        [Description("Properties to update as key-value pairs for a SINGLE record.")]
            Dictionary<string, JsonElement>? item = null,
        [Description("Batch update: an array of {recordId, item} objects (maximum 25).")]
            List<UpdateEntry>? records = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => recordService.UpdateAsync(tablename, recordId, item, records, ct));

    [McpServerTool(Name = "delete_record")]
    [Description(
        "Proceed solely on explicit user consent then only DELETE one or more rows from a table " +
        "in the Dataverse database. Provide 'recordId' to delete a single record, or 'recordIds' " +
        "(an array of GUIDs) to delete multiple records in one call.")]
    public Task<string> DeleteRecord(
        [Description("The logical name (schema name) of the table to delete a record from.")] string tablename,
        [Description(
            "Set this to true only after asking the user if they are ok with the deletion and you " +
            "have received an affirmative response")]
            bool hasUserApproved,
        [Description("The GUID of the single record to delete.")] string? recordId = null,
        [Description("Batch delete: an array of record-id GUIDs (maximum 25).")] List<string>? recordIds = null,
        CancellationToken ct = default)
        => ToolErrors.GuardAsync(() => recordService.DeleteAsync(tablename, hasUserApproved, recordId, recordIds, ct));
}
