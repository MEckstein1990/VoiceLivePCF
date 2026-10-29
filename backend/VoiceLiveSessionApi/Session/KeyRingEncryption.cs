using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Microsoft.AspNetCore.DataProtection.XmlEncryption;
using Microsoft.Extensions.DependencyInjection;

namespace VoiceLiveSessionApi.Session;

/// <summary>
/// Schlüssel, mit dem der Data-Protection-Schlüsselring im Blob verschlüsselt wird. Kommt als
/// beliebiger Text aus <c>DataProtection:KeyEncryptionKey</c>; in Azure lädt die Function App ihn
/// per Key-Vault-Referenz. Daraus wird per HKDF der 256-Bit-AES-Schlüssel abgeleitet.
/// Der Text muss selbst zufällig und lang sein (mindestens 32 Zeichen): HKDF streckt keine
/// schwachen Passwörter.
/// </summary>
public sealed class KeyRingEncryptionKey
{
    private const int MinLength = 32;

    public KeyRingEncryptionKey(string secret)
    {
        secret = secret.Trim();
        if (secret.Length < MinLength)
            throw new InvalidOperationException(
                $"DataProtection:KeyEncryptionKey ist zu kurz (mindestens {MinLength} Zeichen, zufällig).");

        Value = HKDF.DeriveKey(HashAlgorithmName.SHA256, Encoding.UTF8.GetBytes(secret), 32,
            info: Encoding.UTF8.GetBytes("KoRa.DataProtection.KeyRing"));
    }

    internal byte[] Value { get; }
}

/// <summary>Verschlüsselt jeden Schlüssel des Rings mit AES-256-GCM, bevor er in den Blob geschrieben wird.</summary>
internal sealed class AesXmlEncryptor(KeyRingEncryptionKey key) : IXmlEncryptor
{
    private const int NonceSize = 12;
    private const int TagSize = 16;

    public EncryptedXmlInfo Encrypt(XElement plaintextElement)
    {
        var plaintext = Encoding.UTF8.GetBytes(plaintextElement.ToString(SaveOptions.DisableFormatting));
        var result = new byte[NonceSize + TagSize + plaintext.Length];
        var nonce = result.AsSpan(0, NonceSize);
        RandomNumberGenerator.Fill(nonce);

        using var aes = new AesGcm(key.Value, TagSize);
        aes.Encrypt(nonce, plaintext, result.AsSpan(NonceSize + TagSize), result.AsSpan(NonceSize, TagSize));

        return new EncryptedXmlInfo(
            new XElement("encryptedKey", new XElement("value", Convert.ToBase64String(result))),
            typeof(AesXmlDecryptor));
    }
}

/// <summary>
/// Entschlüsselt den Schlüsselring. Data Protection erzeugt die Klasse über den Typnamen im XML;
/// der Konstruktor mit <see cref="IServiceProvider"/> holt den Schlüssel aus der DI.
/// </summary>
public sealed class AesXmlDecryptor(IServiceProvider services) : IXmlDecryptor
{
    private const int NonceSize = 12;
    private const int TagSize = 16;

    public XElement Decrypt(XElement encryptedElement)
    {
        var key = services.GetRequiredService<KeyRingEncryptionKey>();
        var bytes = Convert.FromBase64String((string)encryptedElement.Element("value")!);
        var plaintext = new byte[bytes.Length - NonceSize - TagSize];

        using var aes = new AesGcm(key.Value, TagSize);
        aes.Decrypt(bytes.AsSpan(0, NonceSize), bytes.AsSpan(NonceSize + TagSize), bytes.AsSpan(NonceSize, TagSize), plaintext);

        return XElement.Parse(Encoding.UTF8.GetString(plaintext));
    }
}
