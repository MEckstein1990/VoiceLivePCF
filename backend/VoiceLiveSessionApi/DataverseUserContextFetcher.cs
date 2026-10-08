using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace VoiceLiveSessionApi;

/// <summary>
/// Lädt beim WebSocket-Connect die Teams und eigenen Accounts des Users aus Dataverse Web API.
/// Das Ergebnis wird im UserSessionStore gecacht und vom DataverseMcpProxy für
/// entity-spezifische SQL-Filter verwendet.
///
/// Env-Vars:
///   DATAVERSE_MCP_URL            – wird genutzt um die Dataverse-Basis-URL abzuleiten
///   DATAVERSE_MAX_OWNED_ACCOUNTS – Maximale Anzahl Accounts (Standard: 200)
/// </summary>
public sealed class DataverseUserContextFetcher
{
    private readonly HttpClient _httpClient;
    private readonly DataverseTokenProvider _tokenProvider;
    private readonly ILogger<DataverseUserContextFetcher> _logger;
    private readonly string _dataverseBaseUrl;
    private readonly int _maxAccounts;

    public DataverseUserContextFetcher(
        HttpClient httpClient,
        DataverseTokenProvider tokenProvider,
        ILogger<DataverseUserContextFetcher> logger)
    {
        _httpClient = httpClient;
        _tokenProvider = tokenProvider;
        _logger = logger;

        var mcpUrl = Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL")
            ?? throw new InvalidOperationException("DATAVERSE_MCP_URL missing");
        // Basis-URL: Schema + Host, z.B. https://yourorg.crm.dynamics.com
        _dataverseBaseUrl = new Uri(mcpUrl).GetLeftPart(UriPartial.Authority);

        _maxAccounts = int.TryParse(
            Environment.GetEnvironmentVariable("DATAVERSE_MAX_OWNED_ACCOUNTS"), out var m) ? m : 200;
    }

    /// <summary>
    /// Fetcht Teams + Accounts des Users und gibt einen befüllten UserContext zurück.
    /// Schlägt ein API-Call fehl, wird ein leeres Array zurückgegeben (kein hard fail).
    /// </summary>
    public async Task<UserContext> FetchAsync(string userId, CancellationToken ct = default)
    {
        if (!Guid.TryParse(userId, out _))
            return new UserContext(userId, [], []);

        var token = await _tokenProvider.GetAccessTokenAsync(ct);

        var teamIds   = await FetchTeamIdsAsync(userId, token, ct);
        var accountIds = await FetchOwnedAccountIdsAsync(userId, teamIds, token, ct);

        _logger.LogInformation(
            "UserContext geladen: User={UserId} Teams={TeamCount} Accounts={AccountCount}",
            userId, teamIds.Length, accountIds.Length);

        return new UserContext(userId, teamIds, accountIds);
    }

    // GET /api/data/v9.2/systemusers({userId})/teammembership_association?$select=teamid
    private async Task<string[]> FetchTeamIdsAsync(string userId, string token, CancellationToken ct)
    {
        try
        {
            var url = $"{_dataverseBaseUrl}/api/data/v9.2/systemusers({userId})" +
                      "/teammembership_association?$select=teamid";

            using var resp = await SendGetAsync(url, token, ct);
            resp.EnsureSuccessStatusCode();

            var root = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
            return root?["value"]?.AsArray()
                .Select(v => v?["teamid"]?.GetValue<string>())
                .Where(id => !string.IsNullOrWhiteSpace(id) && Guid.TryParse(id, out _))
                .Select(id => id!)
                .ToArray() ?? [];
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Team-IDs für User {UserId} konnten nicht geladen werden", userId);
            return [];
        }
    }

    // GET /api/data/v9.2/accounts?$filter=_ownerid_value eq userId or _ownerid_value eq teamId1 ...
    private async Task<string[]> FetchOwnedAccountIdsAsync(
        string userId, string[] teamIds, string token, CancellationToken ct)
    {
        try
        {
            // OData-Filter: User und alle seine Teams als Besitzer
            var ownerIds = new[] { userId }.Concat(teamIds).ToArray();
            var filter = string.Join(" or ", ownerIds.Select(id => $"_ownerid_value eq {id}"));
            var url = $"{_dataverseBaseUrl}/api/data/v9.2/accounts" +
                      $"?$filter={Uri.EscapeDataString(filter)}&$select=accountid&$top={_maxAccounts}";

            using var resp = await SendGetAsync(url, token, ct);
            resp.EnsureSuccessStatusCode();

            var root = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
            return root?["value"]?.AsArray()
                .Select(v => v?["accountid"]?.GetValue<string>())
                .Where(id => !string.IsNullOrWhiteSpace(id) && Guid.TryParse(id, out _))
                .Select(id => id!)
                .ToArray() ?? [];
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Account-IDs für User {UserId} konnten nicht geladen werden", userId);
            return [];
        }
    }

    private async Task<HttpResponseMessage> SendGetAsync(string url, string token, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.Add("OData-MaxVersion", "4.0");
        req.Headers.Add("OData-Version", "4.0");
        req.Headers.Add("Accept", "application/json");
        return await _httpClient.SendAsync(req, ct);
    }
}
