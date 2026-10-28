using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace VoiceLiveSessionApi.Session;

/// <summary>
/// Basis für Tokens, die mit der ASP.NET Core Data Protection API verschlüsselt sind
/// (authentifizierte Verschlüsselung inkl. Ablaufzeit). Die Tokens werden serverseitig nicht
/// gespeichert und lassen sich nur mit dem Schlüsselring lesen – den teilen sich alle Instanzen über
/// Blob Storage (siehe <see cref="SessionTokenServiceCollectionExtensions"/>).
/// Der Purpose ist der Scope des Tokens: Jeder Purpose hat einen eigenen abgeleiteten Schlüssel,
/// ein Token mit fremdem Purpose lässt sich nicht entschlüsseln und gilt als ungültig.
/// Bei Formatänderungen des Payloads die Versionsnummer im Purpose erhöhen.
/// </summary>
public abstract class ScopedTokenService
{
    private readonly ITimeLimitedDataProtector _protector;

    protected ScopedTokenService(IDataProtectionProvider provider, string purpose)
        => _protector = provider.CreateProtector(purpose).ToTimeLimitedDataProtector();

    protected string Protect(SessionTokenPayload payload, DateTimeOffset expiresOn)
        => _protector.Protect(JsonSerializer.Serialize(payload), expiresOn);

    /// <summary>Gibt den Payload zurück, oder null wenn das Token manipuliert, fremd (anderer Scope) oder abgelaufen ist.</summary>
    protected SessionTokenPayload? Unprotect(string token)
    {
        try
        {
            var json = _protector.Unprotect(token, out _);
            return JsonSerializer.Deserialize<SessionTokenPayload>(json);
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            return null;
        }
    }
}
