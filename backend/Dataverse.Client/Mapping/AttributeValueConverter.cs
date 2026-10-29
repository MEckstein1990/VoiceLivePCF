using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk;
using System.Globalization;
using System.Text.Json;

namespace Dataverse.Client.Mapping;

/// <summary>
/// Übersetzt zwischen JSON-Werten (vom MCP-Client) und Dataverse-SDK-Typen anhand der Spalten-Metadaten.
/// </summary>
public static class AttributeValueConverter
{
    public static object? ToSdkValue(AttributeMetadata attribute, JsonElement value)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        try
        {
            return Convert(attribute, value);
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or KeyNotFoundException
                                       or OverflowException)
        {
            // Rohe JsonElement-Fehler ("requires an element of type 'Number'") sagen dem LLM nicht,
            // welche Spalte betroffen ist und welches Format erwartet wird.
            var raw = value.GetRawText();
            throw new ArgumentException(
                $"Invalid value for column '{attribute.LogicalName}' ({attribute.AttributeTypeName?.Value ?? attribute.AttributeType?.ToString()}): " +
                $"{(raw.Length > 100 ? raw[..100] + "…" : raw)}. Expected: {ExpectedFormat(attribute)}", ex);
        }
    }

    private static object? Convert(AttributeMetadata attribute, JsonElement value)
    {
        // Multi-Select-Choice hat AttributeType "Virtual" und muss vor dem switch erkannt werden.
        if (attribute is MultiSelectPicklistAttributeMetadata multiSelect)
        {
            return new OptionSetValueCollection(
                value.EnumerateArray().Select(v => new OptionSetValue(ToOptionValue(multiSelect.OptionSet, v))).ToList());
        }

        // Lookups sind echte Objekte; für alle anderen Typen {"value": x} tolerieren
        // (so liefern LLMs Choices/Money gern, z. B. {"value": 1, "label": "Kunde"}).
        if (attribute is not LookupAttributeMetadata)
        {
            value = Unwrap(value);
        }

        return attribute.AttributeType switch
        {
            AttributeTypeCode.String or AttributeTypeCode.Memo => value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : value.GetRawText(),
            // Logischer Tabellenname, z. B. objecttypecode bei annotation ("account"); nie die Typnummer.
            AttributeTypeCode.EntityName => value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : throw new ArgumentException(
                    $"'{attribute.LogicalName}' expects the logical table name as text, e.g. \"account\" (not a number)."),
            AttributeTypeCode.Integer => int.Parse(Number(value), CultureInfo.InvariantCulture),
            AttributeTypeCode.BigInt => long.Parse(Number(value), CultureInfo.InvariantCulture),
            AttributeTypeCode.Decimal => decimal.Parse(Number(value), NumberStyles.Float, CultureInfo.InvariantCulture),
            AttributeTypeCode.Double => double.Parse(Number(value), NumberStyles.Float, CultureInfo.InvariantCulture),
            AttributeTypeCode.Money => new Money(decimal.Parse(Number(value), NumberStyles.Float, CultureInfo.InvariantCulture)),
            AttributeTypeCode.Boolean => value.ValueKind == JsonValueKind.String
                ? bool.Parse(value.GetString()!)
                : value.GetBoolean(),
            AttributeTypeCode.DateTime => value.GetDateTime(),
            AttributeTypeCode.Uniqueidentifier => value.GetGuid(),
            AttributeTypeCode.Picklist or AttributeTypeCode.State or AttributeTypeCode.Status
                => new OptionSetValue(ToOptionValue(((EnumAttributeMetadata)attribute).OptionSet, value)),
            AttributeTypeCode.Lookup or AttributeTypeCode.Customer or AttributeTypeCode.Owner
                => ToEntityReference((LookupAttributeMetadata)attribute, value),
            _ => throw new ArgumentException(
                $"Column type '{attribute.AttributeType}' of '{attribute.LogicalName}' is not supported (yet)."),
        };
    }

    private static JsonElement Unwrap(JsonElement value) =>
        value.ValueKind == JsonValueKind.Object
        && (value.TryGetProperty("value", out var inner) || value.TryGetProperty("Value", out inner)
            || value.TryGetProperty("label", out inner))
            ? inner
            : value;

    /// <summary>Zahl als invarianter String – akzeptiert JSON-Zahlen und Zahlen in Strings ("42", "1500.50").</summary>
    private static string Number(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.String => value.GetString()!.Trim(),
        _ => throw new InvalidOperationException($"Expected a number, got: {value.ValueKind}."),
    };

    /// <summary>Choice-Wert als Zahl oder – bequemer für LLMs – als Label ("Kunde").</summary>
    private static int ToOptionValue(OptionSetMetadata? optionSet, JsonElement value)
    {
        value = Unwrap(value);
        if (value.ValueKind == JsonValueKind.Number
            || int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
        {
            return int.Parse(Number(value), CultureInfo.InvariantCulture);
        }

        var label = value.GetString();
        var match = optionSet?.Options.FirstOrDefault(o =>
            (o.Label?.LocalizedLabels.Any(l => string.Equals(l.Label, label, StringComparison.OrdinalIgnoreCase)) ?? false)
            || string.Equals(o.Label?.UserLocalizedLabel?.Label, label, StringComparison.OrdinalIgnoreCase));

        return match?.Value ?? throw new InvalidOperationException($"Unknown label '{label}'.");
    }

    /// <summary>Erwartetes JSON-Format einer Spalte – für Fehlermeldungen und describe_table.</summary>
    public static string ExpectedFormat(AttributeMetadata attribute, bool includeOptions = true) => attribute switch
    {
        MultiSelectPicklistAttributeMetadata m => $"Array von Werten, z. B. [{FirstOption(m.OptionSet)}]" +
                                                  (includeOptions ? $". Optionen: {Options(m.OptionSet)}" : ""),
        EnumAttributeMetadata e => "Zahlenwert oder Label" + (includeOptions ? $". Optionen: {Options(e.OptionSet)}" : ""),
        LookupAttributeMetadata l => $"{{\"table\": \"{l.Targets?.FirstOrDefault() ?? "<tabelle>"}\", \"id\": \"<guid>\"}}" +
                                     (l.Targets is { Length: > 1 } t ? $" (erlaubt: {string.Join(", ", t)})" : ""),
        _ => attribute.AttributeType switch
        {
            AttributeTypeCode.Integer or AttributeTypeCode.BigInt => "Ganzzahl, z. B. 42",
            AttributeTypeCode.Decimal or AttributeTypeCode.Double or AttributeTypeCode.Money => "Zahl, z. B. 1500.50",
            AttributeTypeCode.Boolean => "true oder false",
            AttributeTypeCode.DateTime => "ISO-8601-Datum, z. B. \"2026-09-22T10:00:00Z\"",
            AttributeTypeCode.Uniqueidentifier => "GUID-String",
            AttributeTypeCode.EntityName => "Logischer Tabellenname als Text, z. B. \"account\"",
            _ => "Text",
        },
    };

    private static string Options(OptionSetMetadata? optionSet) => optionSet is null
        ? "?"
        : string.Join(", ", optionSet.Options.Take(20).Select(o => $"{o.Value}={LabelText(o.Label)}"))
          + (optionSet.Options.Count > 20 ? ", …" : "");

    /// <summary>Label in Benutzersprache, sonst das erste vorhandene.</summary>
    public static string? LabelText(Label? label) =>
        label?.UserLocalizedLabel?.Label ?? label?.LocalizedLabels.FirstOrDefault()?.Label;

    private static string FirstOption(OptionSetMetadata? optionSet) =>
        optionSet?.Options.FirstOrDefault()?.Value?.ToString(CultureInfo.InvariantCulture) ?? "1";

    /// <summary>
    /// Lookup-Werte: entweder {"table": "account", "id": "..."} oder – bei Lookups mit genau einem
    /// Ziel – direkt die GUID als String.
    /// </summary>
    private static EntityReference ToEntityReference(LookupAttributeMetadata attribute, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            if (attribute.Targets is not [var singleTarget])
            {
                throw new ArgumentException(
                    $"'{attribute.LogicalName}' is polymorphic ({string.Join(", ", attribute.Targets ?? [])}). " +
                    "Bitte als {\"table\": \"...\", \"id\": \"...\"} angeben.");
            }

            return new EntityReference(singleTarget, value.GetGuid());
        }

        var table = value.GetProperty("table").GetString()!;
        var id = value.GetProperty("id").GetGuid();

        if (attribute.Targets is { Length: > 0 } targets && !targets.Contains(table, StringComparer.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"'{attribute.LogicalName}' cannot point to '{table}'. Allowed: {string.Join(", ", targets)}.");
        }

        return new EntityReference(table, id);
    }

    /// <summary>SDK-Wert in eine JSON-freundliche Darstellung für die Tool-Antwort umwandeln.</summary>
    public static object? FromSdkValue(object? value) => value switch
    {
        EntityReference r => new { table = r.LogicalName, id = r.Id, name = r.Name },
        OptionSetValue o => o.Value,
        OptionSetValueCollection c => c.Select(o => o.Value).ToArray(),
        Money m => m.Value,
        AliasedValue a => FromSdkValue(a.Value),
        _ => value,
    };
}
