using System.Collections.Concurrent;

namespace VoiceLiveSessionApi;

/// <summary>
/// Enthält den User-Kontext (Teams + Accounts) der beim WS-Connect aus Dataverse geladen wird.
/// Wird vom DataverseMcpProxy für entity-spezifische SQL-Filter verwendet.
/// </summary>
public record UserContext(
    string UserId,
    IReadOnlyList<string> TeamIds,
    IReadOnlyList<string> AccountIds);

/// <summary>
/// Thread-sicherer In-Memory-Cache, der beim WebSocket-Aufbau eine kurzlebige Session-ID
/// (generiert vom VoiceLiveWsProxyFunction) auf die Dataverse-SystemUser-GUID des Users mappt.
///
/// Verwendung:
///   - VoiceLiveWsProxyFunction erstellt beim Connect eine Session → gibt sessionId zurück.
///   - DataverseMcpProxy liest den Query-Param "session" und schlägt die User-GUID nach.
///
/// TTL: DATAVERSE_SESSION_TTL_MINUTES (Standard: 120 Minuten)
/// </summary>
public sealed class UserSessionStore
{
    private sealed record SessionEntry(string UserId, DateTimeOffset ExpiresAt);

    private readonly ConcurrentDictionary<string, SessionEntry> _sessions = new();
    private readonly TimeSpan _ttl;

    public UserSessionStore()
    {
        var ttlMinutes = int.TryParse(
            Environment.GetEnvironmentVariable("DATAVERSE_SESSION_TTL_MINUTES"), out var m) ? m : 120;
        _ttl = TimeSpan.FromMinutes(ttlMinutes);
    }

    /// <summary>Erstellt eine neue Session für den User und gibt die Session-ID zurück.</summary>
    public string CreateSession(string userId)
    {
        var sessionId = Guid.NewGuid().ToString("N");
        _sessions[sessionId] = new SessionEntry(userId, DateTimeOffset.UtcNow.Add(_ttl));
        Cleanup();
        return sessionId;
    }

    /// <summary>Gibt die User-GUID für eine Session-ID zurück, oder null wenn abgelaufen/unbekannt.</summary>
    public string? GetUserId(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var entry))
        {
            if (entry.ExpiresAt > DateTimeOffset.UtcNow)
                return entry.UserId;
            _sessions.TryRemove(sessionId, out _);
        }
        return null;
    }

    /// <summary>Entfernt eine Session explizit (beim WebSocket-Close).</summary>
    public void RemoveSession(string sessionId)
        => _sessions.TryRemove(sessionId, out _);

    // Globaler User-Kontext (GUID + Teams + Accounts) des aktuell verbundenen Users.
    // Wird beim WS-Connect gesetzt und beim Disconnect gelöscht.
    // Bei einem PoC mit einem gleichzeitigen User ausreichend.
    private volatile UserContext? _currentUserContext;

    /// <summary>Setzt den vollständigen User-Kontext (beim WebSocket-Connect).</summary>
    public void SetCurrentUserContext(UserContext? ctx) => _currentUserContext = ctx;

    /// <summary>Gibt den vollständigen User-Kontext zurück, oder null wenn keine Session aktiv.</summary>
    public UserContext? GetCurrentUserContext() => _currentUserContext;

    /// <summary>Gibt die GUID des aktuell verbundenen Users zurück (Kurzform für MSCRMCallerID).</summary>
    public string? GetCurrentCallerId() => _currentUserContext?.UserId;

    private void Cleanup()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var key in _sessions.Keys.ToList())
        {
            if (_sessions.TryGetValue(key, out var e) && e.ExpiresAt <= now)
                _sessions.TryRemove(key, out _);
        }
    }
}
