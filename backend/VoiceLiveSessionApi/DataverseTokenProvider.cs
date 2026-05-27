using Azure.Core;
using Azure.Identity;

namespace VoiceLiveSessionApi;

public sealed class DataverseTokenProvider
{
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(5);

    private readonly ClientSecretCredential _credential;
    private readonly TokenRequestContext _tokenRequestContext;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private AccessToken _cachedToken;

    public DataverseTokenProvider()
    {
        var tenantId = Environment.GetEnvironmentVariable("DATAVERSE_TENANT_ID")
            ?? throw new InvalidOperationException("DATAVERSE_TENANT_ID missing");
        var clientId = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_ID")
            ?? throw new InvalidOperationException("DATAVERSE_CLIENT_ID missing");
        var clientSecret = Environment.GetEnvironmentVariable("DATAVERSE_CLIENT_SECRET")
            ?? throw new InvalidOperationException("DATAVERSE_CLIENT_SECRET missing");
        var mcpUrl = Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL")
            ?? throw new InvalidOperationException("DATAVERSE_MCP_URL missing");

        var scope = Environment.GetEnvironmentVariable("DATAVERSE_SCOPE")
            ?? new Uri(mcpUrl).GetLeftPart(UriPartial.Authority) + "/.default";

        _credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        _tokenRequestContext = new TokenRequestContext([scope]);
    }

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

    private static bool TokenIsFresh(AccessToken token)
        => !string.IsNullOrWhiteSpace(token.Token)
           && token.ExpiresOn > DateTimeOffset.UtcNow.Add(RefreshSkew);
}