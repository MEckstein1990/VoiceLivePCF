using Azure.Core;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace VoiceLiveSessionApi.Session;

public static class SessionTokenServiceCollectionExtensions
{
    /// <summary>
    /// Registriert alle Dienste für /api/voice-live/token sowie Authentifizierung und Policy
    /// für den WebSocket-Proxy.
    /// </summary>
    /// <param name="credential">Identität der App für Blob Storage und Key Vault (Schlüsselring).</param>
    public static IServiceCollection AddSessionToken(
        this IServiceCollection services, IConfiguration configuration, TokenCredential credential)
    {
        AddKeyRing(services, configuration, credential);

        // Kein Default-Scheme: die Authentifizierung wird nur in der VoiceLiveWsRouteFunction
        // explizit über IPolicyEvaluator ausgelöst, nicht für Function-Trigger.
        services.AddAuthentication()
            .AddScheme<AuthenticationSchemeOptions, SessionTokenAuthenticationHandler>(
                SessionTokenAuthenticationDefaults.Scheme, configureOptions: null);
        services.AddAuthorization(options =>
            options.AddPolicy(SessionTokenAuthenticationDefaults.VoiceLiveWsPolicy, policy => policy
                .AddAuthenticationSchemes(SessionTokenAuthenticationDefaults.Scheme)
                .RequireAuthenticatedUser()
                .RequireClaim("kora:agent")));

        services.AddSingleton<UserTokenValidator>();
        services.AddSingleton<WebSocketTokenService>();
        services.AddSingleton<DataverseTokenService>();
        services.AddOptions<SessionTokenOptions>()
            .BindConfiguration(SessionTokenOptions.SectionName)
            .Configure<IConfiguration>((o, config) => o.TenantId = config["TenantId"]);
        services.AddSingleton<SessionTargetPolicy>();
        return services;
    }

    /// <summary>
    /// Schlüssel für Session-Token- und MCP-Token (Data Protection). Alle Instanzen müssen denselben
    /// Schlüsselring nutzen, sonst kann eine Instanz Tokens der anderen nicht lesen (zufällige 401).
    ///   DataProtection:KeyRingBlobUri     – Blob für den Schlüsselring (Rolle Storage Blob Data Contributor)
    ///   DataProtection:KeyEncryptionKey   – Klartext-Schlüssel (beliebiger zufälliger Text, mindestens
    ///                                       32 Zeichen), der den Ring verschlüsselt. In Azure lädt die Function App ihn per
    ///                                       Key-Vault-Referenz, die App selbst greift nicht auf Key Vault zu.
    /// Ohne beide Werte gilt lokal der Standard (Schlüssel in einer lokalen Datei, nur eine Instanz).
    /// In Azure ist die Konfiguration Pflicht: Der Start bricht sonst mit einer Fehlermeldung ab.
    /// </summary>
    private static void AddKeyRing(IServiceCollection services, IConfiguration configuration, TokenCredential credential)
    {
        var builder = services.AddDataProtection().SetApplicationName("KoRa.VoiceLive");

        var blobUri = configuration["DataProtection:KeyRingBlobUri"];
        var keyValue = configuration["DataProtection:KeyEncryptionKey"];
        var hasBlob = !string.IsNullOrWhiteSpace(blobUri);
        var hasKey = !string.IsNullOrWhiteSpace(keyValue);

        if (hasBlob && hasKey)
        {
            var key = new KeyRingEncryptionKey(keyValue!);
            builder.Services.AddSingleton(key);
            builder.PersistKeysToAzureBlobStorage(new Uri(blobUri!), credential);
            builder.Services.Configure<KeyManagementOptions>(options => options.XmlEncryptor = new AesXmlEncryptor(key));
            return;
        }

        // WEBSITE_SITE_NAME setzt App Service bzw. Azure Functions in Azure, nicht lokal.
        if (hasBlob || hasKey || Environment.GetEnvironmentVariable("WEBSITE_SITE_NAME") is not null)
            throw new InvalidOperationException(
                "DataProtection:KeyRingBlobUri und DataProtection:KeyEncryptionKey müssen beide gesetzt sein " +
                "(Schlüsselring für Session-Token- und MCP-Token).");
    }
}
