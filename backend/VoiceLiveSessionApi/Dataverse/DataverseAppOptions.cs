namespace VoiceLiveSessionApi.Dataverse;

/// <summary>
/// App-Registrierung für den Zugriff auf Dataverse (On-Behalf-Of). Ein Tenant, eine
/// App-Registrierung – aber beliebig viele Orgs; welche erlaubt sind, steht in
/// appsettings.json (SessionToken:AllowedTargets).
///
/// Abschnitt "Dataverse" der Konfiguration; die Tenant-ID kommt aus dem gemeinsamen Top-Level-Wert
/// "TenantId". Geheimnisse (Secret, Zertifikat, Dev-Token) nur als App-Setting, z.B.
/// Dataverse__ClientSecret. Anmeldedaten in dieser Reihenfolge: Zertifikat aus Key Vault (empfohlen für Produktion) → Zertifikat als Base64 →
/// Zertifikat als Datei (lokal) → Client Secret.
/// </summary>
public sealed class DataverseAppOptions
{
    public const string SectionName = "Dataverse";

    public string? TenantId { get; set; }
    public string? ClientId { get; set; }

    /// <summary>z. B. https://kv-enbwai-kora1.vault.azure.net/; Zugriff mit der App-Identität.</summary>
    public string? CertificateKeyVaultUrl { get; set; }
    public string? CertificateKeyVaultName { get; set; }

    /// <summary>PFX als Base64, z. B. als App-Setting.</summary>
    public string? CertificateBase64 { get; set; }

    /// <summary>Pfad zu einer PFX-Datei, für lokale Entwicklung.</summary>
    public string? CertificatePath { get; set; }
    public string? CertificatePassword { get; set; }

    public string? ClientSecret { get; set; }

    /// <summary>
    /// Nur Entwicklung: festes Dataverse-Token statt Durchreichen/OBO. Der Aufrufer wird
    /// trotzdem geprüft.
    /// </summary>
    public string? DevBearerToken { get; set; }

    public bool HasKeyVaultCertificate
        => !string.IsNullOrWhiteSpace(CertificateKeyVaultUrl) && !string.IsNullOrWhiteSpace(CertificateKeyVaultName);

    public bool HasCredential
        => HasKeyVaultCertificate
           || !string.IsNullOrWhiteSpace(CertificateBase64)
           || !string.IsNullOrWhiteSpace(CertificatePath)
           || !string.IsNullOrWhiteSpace(ClientSecret);
}
