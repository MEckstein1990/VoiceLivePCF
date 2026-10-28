using Dataverse.Client.Mapping;
using Microsoft.Xrm.Sdk.Metadata;
using System.Text;

namespace Dataverse.Client.Metadata;

/// <summary>
/// Schreibt Tabellen-Metadaten in das Pseudo-SQL-Format, das der Dataverse-MCP-Server von
/// Microsoft liefert. Wörtlich nachgebildet, damit Clients austauschbar bleiben.
/// <para>
/// Beispiel aus <c>docs/reference/ms-sample-describe-tables-contact.txt</c>:
/// <code>
/// -- Collection Name: contacts
/// -- Description: Person with whom a business unit has a relationship, ...
/// DESCRIBE TABLE contact (
///   accountid LOOKUP (GUID) ( Related table : account),
///   accountrolecode CHOICE (Options: Decision Maker (1), Employee (2)),
///   address1_city NVARCHAR(80),
///   statecode STATE (INT) (Valid Options: Active (0), Inactive (1))
/// );
/// </code>
/// </para>
/// <para>
/// Das Format trägt Choice-Werte und Lookup-Ziele bereits in sich — also genau die Angaben,
/// die ein Modell braucht, um Spaltenwerte nicht zu raten.
/// </para>
/// </summary>
public static class TableSchemaFormatter
{
    public static string Format(EntityMetadata entity)
    {
        var text = new StringBuilder();
        text.Append("-- Collection Name: ").AppendLine(entity.EntitySetName);

        if (AttributeValueConverter.LabelText(entity.Description) is { Length: > 0 } description)
        {
            text.Append("-- Description: ").AppendLine(description);
        }

        text.Append("DESCRIBE TABLE ").Append(entity.LogicalName).AppendLine(" (");

        var columns = (entity.Attributes ?? [])
            // Abgeleitete Hilfsspalten (z. B. "primarycontactidname" zu einem Lookup) haben
            // AttributeOf gesetzt und sind für Abfragen uninteressant.
            .Where(a => a.AttributeOf is null)
            // Microsoft zeigt rein interne Spalten nicht an.
            .Where(a => a.IsValidForRead ?? true)
            .OrderBy(a => a.LogicalName, StringComparer.Ordinal)
            .Select(a => $"  {a.LogicalName} {TypeOf(a)}{NotNull(a)}")
            .ToList();

        text.AppendLine(string.Join("," + Environment.NewLine, columns));
        text.AppendLine(");");

        return text.ToString();
    }

    /// <summary>
    /// Microsoft markiert nur fachliche Pflichtfelder mit NOT NULL. Systemseitig gesetzte Spalten
    /// (Primärschlüssel, Besitzer, Status) sind zwar ebenfalls nie leer, erscheinen dort aber ohne
    /// die Markierung — sie füllt die Plattform, nicht der Aufrufer.
    /// </summary>
    private static string NotNull(AttributeMetadata attribute) =>
        attribute.RequiredLevel?.Value == AttributeRequiredLevel.ApplicationRequired
            ? " NOT NULL"
            : string.Empty;

    private static string TypeOf(AttributeMetadata attribute) => attribute switch
    {
        LookupAttributeMetadata lookup => LookupType(lookup),
        EnumAttributeMetadata choice => ChoiceType(choice),
        StringAttributeMetadata text => StringType(text),
        MemoAttributeMetadata => "MULTILINE TEXT",
        IntegerAttributeMetadata { Format: IntegerFormat.TimeZone } => "TIMEZONE (INT)",
        IntegerAttributeMetadata { Format: IntegerFormat.Duration } => "DURATION (INT)",
        IntegerAttributeMetadata { Format: IntegerFormat.Language } => "LANGUAGE (INT)",
        IntegerAttributeMetadata => "INT",
        BigIntAttributeMetadata => "BIGINT",
        DoubleAttributeMetadata => "FLOAT",
        DecimalAttributeMetadata => "DECIMAL",
        MoneyAttributeMetadata => "MONEY",
        BooleanAttributeMetadata => "BIT",
        DateTimeAttributeMetadata date => date.Format == DateTimeFormat.DateOnly ? "DATE ONLY" : "DATETIME",
        UniqueIdentifierAttributeMetadata => "GUID",
        // Nicht jede GUID-Spalte kommt als UniqueIdentifierAttributeMetadata; manche tragen den
        // Typ nur im AttributeType. Microsoft schreibt in beiden Fällen GUID.
        { AttributeType: AttributeTypeCode.Uniqueidentifier } => "GUID",
        { AttributeType: AttributeTypeCode.EntityName } => "ENTITYNAME",
        _ => attribute.AttributeType?.ToString().ToUpperInvariant() ?? "UNKNOWN",
    };

    private static string LookupType(LookupAttributeMetadata lookup)
    {
        // Customer-Spalten zeigen auf mehrere Tabellen und heißen auch so.
        if (lookup.AttributeType == AttributeTypeCode.Owner)
        {
            return "OWNER";
        }

        var kind = lookup.AttributeType == AttributeTypeCode.Customer ? "CUSTOMER" : "LOOKUP";
        var targets = string.Join(", ", lookup.Targets ?? []);

        return $"{kind} (GUID) ( Related table : {targets})";
    }

    private static string ChoiceType(EnumAttributeMetadata choice)
    {
        var options = string.Join(", ", (choice.OptionSet?.Options ?? [])
            .Where(o => o.Value.HasValue)
            .Select(o => $"{AttributeValueConverter.LabelText(o.Label)} ({o.Value})"));

        // State und Status tragen bei Microsoft andere Bezeichner als gewöhnliche Choices.
        return choice switch
        {
            StateAttributeMetadata => $"STATE (INT) (Valid Options: {options})",
            StatusAttributeMetadata => $"STATUS (INT) (Valid Options: {options})",
            MultiSelectPicklistAttributeMetadata => $"MULTISELECT CHOICE (Options: {options})",
            _ => $"CHOICE (Options: {options})",
        };
    }

    private static string StringType(StringAttributeMetadata text)
    {
        var length = text.MaxLength ?? 100;

        return text.FormatName?.Value switch
        {
            "Phone" => $"PHONE (NVARCHAR({length}))",
            "Url" => $"URL (NVARCHAR({length}))",
            "Email" => $"EMAIL (NVARCHAR({length}))",
            "TextArea" => "MULTILINE TEXT",
            _ => $"NVARCHAR({length})",
        };
    }
}
