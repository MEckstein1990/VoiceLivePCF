using Microsoft.Extensions.Caching.Memory;
using Microsoft.PowerPlatform.Dataverse.Client;

namespace Dataverse.Client.Connection;

/// <summary>
/// Cache für Dataverse-Clients je Benutzer. Jeder Client hält eine eigene Verbindung, daher
/// Obergrenze und Ablaufzeit; beim Verdrängen wird der Client verworfen.
/// </summary>
public sealed class DataverseClientCache : IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(20);
    public const int MaxClients = 50;

    private readonly MemoryCache _cache = new(new MemoryCacheOptions { SizeLimit = MaxClients });
    private readonly Lock _lock = new();

    public ServiceClient GetOrCreate(string key, Func<ServiceClient> factory)
    {
        if (_cache.TryGetValue(key, out ServiceClient? cached) && cached is not null)
        {
            return cached;
        }

        // Verhindert, dass bei parallelen Anfragen desselben Benutzers mehrere Verbindungen entstehen.
        lock (_lock)
        {
            if (_cache.TryGetValue(key, out cached) && cached is not null)
            {
                return cached;
            }

            var client = factory();
            _cache.Set(key, client, new MemoryCacheEntryOptions
            {
                Size = 1,
                SlidingExpiration = Lifetime,
                PostEvictionCallbacks =
                {
                    new PostEvictionCallbackRegistration
                    {
                        EvictionCallback = static (_, value, _, _) => (value as ServiceClient)?.Dispose(),
                    },
                },
            });

            return client;
        }
    }

    public void Dispose() => _cache.Dispose();
}
