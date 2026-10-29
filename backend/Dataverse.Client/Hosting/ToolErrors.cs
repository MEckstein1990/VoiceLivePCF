using Azure.Identity;
using Dataverse.Client.Connection;
using Microsoft.Data.SqlClient;
using Microsoft.Identity.Client;
using Microsoft.PowerPlatform.Dataverse.Client.Utils;
using Microsoft.Xrm.Sdk;
using System.ServiceModel;
using System.Text.Json;

namespace Dataverse.Client.Hosting;

/// <summary>
/// Übersetzt erwartbare Fehler in Meldungen, die ein Modell verstehen und zur Selbstkorrektur
/// nutzen kann ("Spalte X existiert nicht in Tabelle Y").
/// <para>
/// Hosts ersetzen Exception-Meldungen gern durch einen generischen Text. Für ein LLM sind sie
/// aber die wichtigste Rückkopplung — deshalb werden Eingabe- und Dataverse-Fehler im Klartext
/// durchgereicht. Gibt <c>null</c> zurück, wenn der Fehler unerwartet ist und besser als
/// Serverfehler behandelt wird.
/// </para>
/// </summary>
public static class ToolErrors
{
    /// <summary>
    /// Führt einen Werkzeugaufruf aus und gibt erwartbare Fehler als Text zurück.
    /// <para>
    /// Nötig, weil Hosts geworfene Ausnahmen durch einen nichtssagenden Text ersetzen — die
    /// Functions-MCP-Erweiterung meldet nur „An error occurred invoking 'read_query'“. Das
    /// Modell kann sich damit nicht korrigieren. Unerwartete Fehler werden weitergereicht,
    /// damit sie in der Protokollierung sichtbar bleiben.
    /// </para>
    /// </summary>
    public static async Task<string> GuardAsync(Func<Task<string>> run)
    {
        try
        {
            return await run();
        }
        catch (Exception ex) when (ToClientMessage(ex) is { } message)
        {
            return $"Error: {message}";
        }
    }

    public static string? ToClientMessage(Exception ex) => ex switch
    {
        FaultException<OrganizationServiceFault> fault => $"Dataverse: {fault.Detail?.Message ?? fault.Message}",
        MsalUiRequiredException => "Sign-in or consent required: the user token is not sufficient for Dataverse. " +
                                   "Please sign in again in the MCP client.",
        MsalServiceException msal => $"Entra ID: {msal.Message}",
        // On-Behalf-Of über Azure.Identity (z. B. abgelaufenes Benutzer-Token, fehlende Zustimmung)
        AuthenticationFailedException => $"Entra ID: {Innermost(ex).Message}",
        DataverseConnectionException => $"Connection to Dataverse failed: {Innermost(ex).Message}",
        // Verbindungsfehler (z. B. falsche DATAVERSE_URL, DNS, Firewall)
        EndpointNotFoundException or CommunicationException => $"Connection to Dataverse failed: {ex.Message}",
        // Dataverse SQL meldet Fehler als JSON im Text, z. B.
        // {"Message":"'UPDATE' statement is not supported. Line:1, Position:1"}. Für das Modell
        // ist genau dieser Text die Rückkopplung, mit der es die Abfrage korrigieren kann.
        SqlException sql => $"Dataverse SQL: {SqlMessage(sql)}",
        ArgumentException or FormatException or KeyNotFoundException => ex.Message,
        // Konfigurationsfehler (fehlende .env-Werte, Verbindung) und falsche JSON-Typen (JsonElement.GetXxx).
        InvalidOperationException => ex.Message,
        // Alles andere bleibt generisch (SDK-Standardverhalten).
        _ => null,
    };

    /// <summary>Packt die Meldung aus dem JSON aus, das der TDS-Endpunkt liefert.</summary>
    private static string SqlMessage(SqlException sql)
    {
        var text = sql.Message.Trim();

        // Der Text sieht aus wie: {"Message":"Invalid column name 'x'."} RequestId: TDS;… Time: …
        // Uns interessiert nur die Meldung; RequestId und Zeitstempel sind für das Modell Lärm.
        if (text.StartsWith('{') && text.IndexOf('}') is var end and > 0)
        {
            try
            {
                using var document = JsonDocument.Parse(text[..(end + 1)]);
                if (document.RootElement.TryGetProperty("Message", out var message))
                {
                    return message.GetString() ?? text;
                }
            }
            catch (JsonException)
            {
                // Nicht jeder Fehler kommt als JSON — dann bleibt der Originaltext.
            }
        }

        return text;
    }

    /// <summary>Der ServiceClient verpackt die eigentliche Ursache oft mehrfach.</summary>
    private static Exception Innermost(Exception ex)
    {
        while (ex.InnerException is { } inner)
        {
            ex = inner;
        }

        return ex;
    }
}
