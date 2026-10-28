using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Certificates;
using Microsoft.Extensions.Options;

namespace VoiceLiveSessionApi.Dataverse;

/// <summary>
/// Anmeldedaten der App-Registrierung (<see cref="DataverseAppOptions"/>) und daraus gebaute
/// On-Behalf-Of-Credentials, mit denen ein User-Token gegen ein Dataverse-Token getauscht wird.
/// Dataverse erzwingt dann die Security Roles des Users.
///
/// Voraussetzungen für OBO: delegierte Berechtigung "user_impersonation" auf Dynamics CRM, und
/// das User-Token muss für diese App (ClientId) ausgestellt sein.
/// </summary>
public sealed class DataverseAppCredentials
{
    private readonly string _tenantId;
    private readonly string _clientId;
    private readonly X509Certificate2? _certificate;
    private readonly string? _clientSecret;

    /// <param name="azureCredential">Identität der App selbst – nur für den Key-Vault-Zugriff.</param>
    public DataverseAppCredentials(IOptions<DataverseAppOptions> options, TokenCredential azureCredential)
    {
        var o = options.Value;
        _tenantId = o.TenantId!;
        _clientId = o.ClientId!;

        if (o.HasKeyVaultCertificate)
        {
            var client = new CertificateClient(new Uri(o.CertificateKeyVaultUrl!), azureCredential);
            _certificate = client.DownloadCertificate(o.CertificateKeyVaultName!).Value;
        }
        else if (!string.IsNullOrWhiteSpace(o.CertificateBase64))
        {
            _certificate = X509CertificateLoader.LoadPkcs12(Convert.FromBase64String(o.CertificateBase64),
                o.CertificatePassword, X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.EphemeralKeySet);
        }
        else if (!string.IsNullOrWhiteSpace(o.CertificatePath))
        {
            _certificate = X509CertificateLoader.LoadPkcs12FromFile(o.CertificatePath,
                o.CertificatePassword, X509KeyStorageFlags.MachineKeySet | X509KeyStorageFlags.EphemeralKeySet);
        }
        else
        {
            _clientSecret = o.ClientSecret;
        }
    }

    /// <summary>
    /// OBO-Credential für ein User-Token. Die Instanz hält ihren eigenen Token-Cache – wer sie
    /// wiederverwendet, spart den Tausch bei Entra, solange das Dataverse-Token gültig ist.
    /// </summary>
    public TokenCredential CreateOnBehalfOf(string userAccessToken)
        => _certificate is not null
            ? new OnBehalfOfCredential(_tenantId, _clientId, _certificate, userAccessToken)
            : new OnBehalfOfCredential(_tenantId, _clientId, _clientSecret!, userAccessToken);
}
