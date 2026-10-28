namespace Dataverse.Client.Connection;

/// <summary>
/// Besorgt ein Dataverse-Zugriffstoken. Woher es stammt — On-Behalf-Of oder eine feste
/// Zeichenkette — entscheidet der Aufrufer.
/// </summary>
public delegate Task<string> DataverseTokenProvider(CancellationToken cancellationToken);

/// <summary>
/// Wer zugreift und wie dessen Token besorgt wird — bewusst als ein Wert.
/// <para>
/// Getrennt gereichte Schlüssel und Tokenquellen sind die übliche Ursache vergifteter Caches:
/// Irgendwo werden Schlüssel des einen und Inhalt des anderen zusammengeführt. Als Paar kann
/// das nicht passieren.
/// </para>
/// </summary>
/// <param name="Key">
/// Schlüssel aller benutzerbezogenen Caches, üblicherweise <c>"{tid}|{oid}|{org-url}"</c>.
/// Muss die Umgebung enthalten, sonst teilen sich zwei Umgebungen desselben Benutzers einen Client.
/// </param>
/// <param name="Url">Environment-URL, z. B. https://contoso.crm4.dynamics.com.</param>
/// <param name="GetToken">Besorgt das Token; wird bei jedem Bedarf erneut aufgerufen.</param>
public sealed record DataverseIdentity(string Key, Uri Url, DataverseTokenProvider GetToken);
