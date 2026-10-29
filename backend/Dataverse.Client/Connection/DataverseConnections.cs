using Microsoft.Data.SqlClient;
using Microsoft.PowerPlatform.Dataverse.Client;

namespace Dataverse.Client.Connection;

/// <summary>
/// Stellt Verbindungen nach Dataverse her — für eine beliebige <see cref="DataverseIdentity"/>.
/// <see cref="GetService"/> spricht den Organization Service (SOAP), <see cref="OpenSqlAsync"/>
/// den TDS-Endpunkt für Dataverse SQL.
/// </summary>
public sealed class DataverseConnections(
    DataverseClientCache cache,
    ILogger<ServiceClient> logger)
{
    /// <summary>
    /// Der Organization-Service-Client dieser Identität, aus dem Cache oder neu verbunden.
    /// </summary>
    public IOrganizationServiceAsync2 GetService(DataverseIdentity identity) =>
        cache.GetOrCreate(identity.Key, () => Connect(identity));

    private ServiceClient Connect(DataverseIdentity identity)
    {
        // Der ServiceClient ruft den Tokenanbieter ohne CancellationToken auf; dort bleibt uns
        // nur None. Beim TDS-Weg unten ist der Token echt nutzbar.
        var client = new ServiceClient(
            identity.Url,
            _ => identity.GetToken(CancellationToken.None),
            useUniqueInstance: true,
            logger: logger);

        if (!client.IsReady)
        {
            client.Dispose();
            throw new InvalidOperationException(
                $"Connection to Dataverse failed: {client.LastError}", client.LastException);
        }

        return client;
    }

    /// <summary>
    /// Öffnet eine SQL-Verbindung zum TDS-Endpunkt (Dataverse SQL, nur lesend).
    /// <para>
    /// Bewusst ohne Wiederverwendung: Der Verbindungspool von <c>Microsoft.Data.SqlClient</c>
    /// nimmt das Zugriffstoken nicht in den Pool-Schlüssel auf. Eine gepoolte Verbindung könnte
    /// sonst mit der Identität eines anderen Benutzers wiederverwendet werden.
    /// </para>
    /// </summary>
    public async Task<SqlConnection> OpenSqlAsync(DataverseIdentity identity, CancellationToken cancellationToken)
    {
        var host = identity.Url.Host;
        var connectionString = new SqlConnectionStringBuilder
        {
            DataSource = $"{host},{TdsPort}",
            // Bei Dataverse ist der Host zugleich der Katalogname — es gibt keine Datenbanken
            // zur Auswahl, die Umgebung ist der Katalog.
            InitialCatalog = host,
            Encrypt = true,
            ConnectTimeout = 30,
        }.ConnectionString;

        var connection = new SqlConnection(connectionString)
        {
            AccessToken = await identity.GetToken(cancellationToken),
        };

        try
        {
            await connection.OpenAsync(cancellationToken);
            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    /// <summary>Port 1433 wird häufig von Firewalls blockiert; 5558 ist der Ausweichport.</summary>
    private const int TdsPort = 5558;
}
