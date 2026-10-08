using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Certificates;

namespace VoiceLiveSessionApi;

public sealed class DataverseTokenProvider
{
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(5);

    private readonly TokenCredential _credential;
    private readonly TokenRequestContext _tokenRequestContext;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    // Gespeichert für OBO-Flow (On-Behalf-Of)
    private readonly string _tenantId;
    private readonly string _clientId;
    private readonly string _scope;
    private X509Certificate2? _certificate;
    private string? _clientSecret;

    private AccessToken _cachedToken;

    public DataverseTokenProvider()
    {
        _tenantId = Environment.GetEnvironmentVariable("DATAVERSE_TENANT_ID")
            ?? throw new InvalidOperationException("DATAVERSE_TENANT_ID missing");
        _clientId = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_ID")
            ?? throw new InvalidOperationException("DATAVERSE_CLIENT_ID missing");
        var mcpUrl = Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL")
            ?? throw new InvalidOperationException("DATAVERSE_MCP_URL missing");

        _scope = Environment.GetEnvironmentVariable("DATAVERSE_SCOPE")
            ?? new Uri(mcpUrl).GetLeftPart(UriPartial.Authority) + "/.default";

        // Zertifikat-Authentifizierung hat Vorrang vor Client Secret.
        // Option A: KeyVault – Zertifikat direkt aus Azure Key Vault laden (empfohlen für Produktion)
        //           DATAVERSE_CLIENT_CERTIFICATE_KEYVAULT_URL  → z.B. https://kv-enbwai-kora1.vault.azure.net/
        //           DATAVERSE_CLIENT_CERTIFICATE_KEYVAULT_NAME → Zertifikatname im KeyVault
        //           Zugriff über DefaultAzureCredential (Managed Identity in Azure, az login lokal)
        // Option B: Base64-kodiertes PFX in DATAVERSE_CLIENT_CERTIFICATE_BASE64
        //           → alternativ für Azure (als App Setting speichern)
        // Option C: Pfad zu PFX-Datei in DATAVERSE_CLIENT_CERTIFICATE_PATH
        //           → für lokale Entwicklung
        // Option D: DATAVERSE_CLIENT_SECRET → Fallback
        var kvUrl    = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_CERTIFICATE_KEYVAULT_URL");
        var kvName   = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_CERTIFICATE_KEYVAULT_NAME");
        var certBase64 = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_CERTIFICATE_BASE64");
        var certPath   = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_CERTIFICATE_PATH");
        var certPassword = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_CERTIFICATE_PASSWORD");

        if (!string.IsNullOrWhiteSpace(kvUrl) && !string.IsNullOrWhiteSpace(kvName))
        {
            var kvCredential = new DefaultAzureCredential();
            var certClient = new CertificateClient(new Uri(kvUrl), kvCredential);
            var downloaded = certClient.DownloadCertificate(kvName);
            _certificate = downloaded.Value;
            _credential = new ClientCertificateCredential(_tenantId, _clientId, _certificate);
        }
        else if (!string.IsNullOrWhiteSpace(certBase64))
        {
            var certBytes = Convert.FromBase64String(certBase64);
            _certificate = new X509Certificate2(certBytes, certPassword,
                X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.EphemeralKeySet);
            _credential = new ClientCertificateCredential(_tenantId, _clientId, _certificate);
        }
        else if (!string.IsNullOrWhiteSpace(certPath))
        {
            _certificate = new X509Certificate2(certPath, certPassword,
                X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.EphemeralKeySet);
            _credential = new ClientCertificateCredential(_tenantId, _clientId, _certificate);
        }
        else
        {
            _clientSecret = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_SECRET")
                ?? throw new InvalidOperationException(
                    "Weder DATAVERSE_CLIENT_CERTIFICATE_BASE64 noch DATAVERSE_CLIENT_CERTIFICATE_PATH noch DATAVERSE_CLIENT_SECRET gesetzt.");
            _credential = new ClientSecretCredential(_tenantId, _clientId, _clientSecret);
        }

        _tokenRequestContext = new TokenRequestContext([_scope]);
    }

    /// <summary>
    /// Gibt ein gecachtes Service-Principal-Token zurück (für den Standard-Proxy-Flow).
    /// </summary>
    public async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken)
    {
        if (TokenIsFresh(_cachedToken))
        {
            return _cachedToken.Token;
        }

        await _refreshLock.WaitAsync(cancellationToken);

        try
        {
            if (TokenIsFresh(_cachedToken))
            {
                return _cachedToken.Token;
            }

            _cachedToken = await _credential.GetTokenAsync(_tokenRequestContext, cancellationToken);
            return _cachedToken.Token;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>
    /// On-Behalf-Of Flow: tauscht das eingehende User-AAD-Token gegen ein Dataverse-Token
    /// des jeweiligen Nutzers aus. Dataverse erzwingt dann die eigenen Security Roles.
    ///
    /// Voraussetzungen:
    ///   - AppReg benötigt delegierte Berechtigung "user_impersonation" auf Dynamics 365
    ///   - Das eingehende <paramref name="userAccessToken"/> muss für die AppReg (client_id) oder
    ///     eine vertrauenswürdige Resource ausgestellt worden sein
    ///
    /// OBO-Token werden nicht gecacht – jeder Request erzeugt ein neues Credential-Objekt.
    /// Bei hohem Durchsatz sollte eine Token-Cache-Strategie ergänzt werden.
    /// </summary>
    public async Task<string> GetAccessTokenOnBehalfOfAsync(string userAccessToken, CancellationToken cancellationToken)
    {
        OnBehalfOfCredential oboCredential = _certificate is not null
            ? new OnBehalfOfCredential(_tenantId, _clientId, _certificate, userAccessToken)
            : new OnBehalfOfCredential(_tenantId, _clientId, _clientSecret!, userAccessToken);

        var token = await oboCredential.GetTokenAsync(
            new TokenRequestContext([_scope]), cancellationToken);

        return token.Token;
    }

    private static bool TokenIsFresh(AccessToken token)
        => !string.IsNullOrWhiteSpace(token.Token)
           && token.ExpiresOn > DateTimeOffset.UtcNow.Add(RefreshSkew);
}