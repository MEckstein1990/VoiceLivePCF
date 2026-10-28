namespace Dataverse.Client.Connection;

/// <summary>Token-Scopes für Dataverse.</summary>
public static class DataverseScopes
{
    /// <summary>Scope für eine Org, z. B. https://org.crm4.dynamics.com/.default.</summary>
    public static string For(Uri orgUrl) => $"{orgUrl.GetLeftPart(UriPartial.Authority)}/.default";
}
