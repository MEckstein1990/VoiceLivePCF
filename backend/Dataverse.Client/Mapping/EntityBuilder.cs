using Dataverse.Client.Metadata;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk;
using System.ComponentModel;
using System.Text.Json;

namespace Dataverse.Client.Mapping;

public sealed record RecordInput(
    [property: Description("LogicalName der Tabelle, z. B. 'account'.")]
    string Table,
    [property: Description("Spaltenwerte als { logicalName: wert }. Lookups: {\"table\":\"account\",\"id\":\"<guid>\"}; Choices: Zahlenwert.")]
    Dictionary<string, JsonElement> Attributes,
    [property: Description("Optional: Unterobjekte, die in derselben Transaktion mit angelegt werden (Deep Insert).")]
    IReadOnlyList<RelatedRecordsInput>? Related = null);

public sealed record RelatedRecordsInput(
    [property: Description("SchemaName der Beziehung aus describe_table (includeRelationships=true), z. B. 'contact_customer_accounts'.")]
    string Relationship,
    [property: Description("Die anzulegenden verknüpften Datensätze.")]
    IReadOnlyList<RecordInput> Records);

/// <summary>Baut aus einem <see cref="RecordInput"/>-Baum eine SDK-<see cref="Entity"/> inkl. RelatedEntities.</summary>
public sealed class EntityBuilder(MetadataCache metadata)
{
    public async Task<Entity> BuildAsync(RecordInput input, bool isCreate)
    {
        var table = await metadata.GetAsync(input.Table);
        var entity = new Entity(table.LogicalName);

        foreach (var (name, value) in input.Attributes)
        {
            var attribute = table.GetAttribute(name);

            EnsureWritable(attribute, isCreate);

            // null leert die Spalte (Update) bzw. setzt sie explizit leer (Create).
            if (value.ValueKind == JsonValueKind.Null)
            {
                EnsureNullable(attribute);
            }

            entity[attribute.LogicalName] = AttributeValueConverter.ToSdkValue(attribute, value);
        }

        foreach (var related in input.Related ?? [])
        {
            if (!isCreate)
            {
                throw new ArgumentException("Related records are only supported when creating.");
            }

            var children = new EntityCollection();
            foreach (var child in related.Records)
            {
                children.Entities.Add(await BuildAsync(child, isCreate: true));
            }

            entity.RelatedEntities[new Relationship(related.Relationship)] = children;
        }

        return entity;
    }

    /// <summary>
    /// Prüft, ob eine Spalte in dieser Operation geschrieben werden darf.
    /// Dataverse selbst würde nicht beschreibbare Spalten teils stillschweigend ignorieren,
    /// teils mit einer wenig aussagekräftigen Fehlermeldung ablehnen.
    /// </summary>
    private static void EnsureWritable(AttributeMetadata attribute, bool isCreate)
    {
        var writable = isCreate
            ? attribute.IsValidForCreate ?? false
            : attribute.IsValidForUpdate ?? false;

        if (!writable)
        {
            throw new ArgumentException(
                $"Column '{attribute.LogicalName}' is not writable on {(isCreate ? "create" : "update")}.");
        }
    }

    /// <summary>
    /// Verhindert das Leeren von Pflichtspalten. Wichtig: "ApplicationRequired" (Business Required)
    /// wird nur in der UI erzwungen, die API würde das Leeren klaglos akzeptieren.
    /// </summary>
    private static void EnsureNullable(AttributeMetadata attribute)
    {
        var level = attribute.RequiredLevel?.Value;
        if (level is AttributeRequiredLevel.SystemRequired or AttributeRequiredLevel.ApplicationRequired)
        {
            throw new ArgumentException(
                $"Column '{attribute.LogicalName}' is required ({level}) and cannot be set to null.");
        }
    }
}
