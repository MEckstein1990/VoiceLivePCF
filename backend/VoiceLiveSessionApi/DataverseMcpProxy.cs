using System.Net;
using System.Net.Http.Headers;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi;

public sealed class DataverseMcpProxy
{
    private static readonly HashSet<string> RequestHeadersToSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "Authorization",
        "Connection",
        "Content-Length",
        "Host",
        "Transfer-Encoding",
        "X-Proxy-Key"
    };

    private static readonly HashSet<string> ResponseHeadersToSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection",
        "Content-Length",
        "Keep-Alive",
        "Set-Cookie",
        "Transfer-Encoding"
    };

    private readonly HttpClient _httpClient;
    private readonly DataverseTokenProvider _tokenProvider;
    private readonly ILogger<DataverseMcpProxy> _logger;
    private readonly string _dataverseMcpUrl;
    private readonly string? _proxyApiKey;

    public DataverseMcpProxy(
        HttpClient httpClient,
        DataverseTokenProvider tokenProvider,
        ILogger<DataverseMcpProxy> logger)
    {
        _httpClient = httpClient;
        _tokenProvider = tokenProvider;
        _logger = logger;
        _dataverseMcpUrl = (Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL")
            ?? throw new InvalidOperationException("DATAVERSE_MCP_URL missing")).TrimEnd('/');
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
    }

    [Function("DataverseMcpProxyRoot")]
    public Task<HttpResponseData> ProxyRoot(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", "put", "patch", "delete", "options", Route = "mcp")] HttpRequestData req,
        FunctionContext context)
        => ProxyAsync(req, string.Empty, context.CancellationToken);

    [Function("DataverseMcpProxyPath")]
    public Task<HttpResponseData> ProxyPath(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", "put", "patch", "delete", "options", Route = "mcp/{*path}")] HttpRequestData req,
        string? path,
        FunctionContext context)
        => ProxyAsync(req, path ?? string.Empty, context.CancellationToken);

    private async Task<HttpResponseData> ProxyAsync(HttpRequestData req, string path, CancellationToken cancellationToken)
    {
        if (!IsProxyKeyValid(req))
        {
            var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
            await unauthorized.WriteStringAsync("Invalid proxy key.", cancellationToken);
            return unauthorized;
        }

        var token = await _tokenProvider.GetAccessTokenAsync(cancellationToken);
        var backendUri = BuildBackendUri(req, path);

        using var backendRequest = new HttpRequestMessage(new HttpMethod(req.Method), backendUri);
        CopyRequestHeaders(req, backendRequest);
        backendRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        if (RequestCanHaveBody(req.Method))
        {
            backendRequest.Content = new StreamContent(req.Body);
            CopyContentHeaders(req, backendRequest);
        }

        using var backendResponse = await _httpClient.SendAsync(
            backendRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        var response = req.CreateResponse(backendResponse.StatusCode);
        CopyResponseHeaders(backendResponse, response);

        await using var backendStream = await backendResponse.Content.ReadAsStreamAsync(cancellationToken);
        await backendStream.CopyToAsync(response.Body, cancellationToken);

        _logger.LogInformation(
            "Relayed MCP request {Method} {Path} -> {StatusCode}",
            req.Method,
            backendUri.PathAndQuery,
            (int)backendResponse.StatusCode);

        return response;
    }

    private bool IsProxyKeyValid(HttpRequestData req)
    {
        if (string.IsNullOrWhiteSpace(_proxyApiKey))
        {
            return true;
        }

        if (TryReadProxyKey(req, out var providedKey))
        {
            return string.Equals(providedKey, _proxyApiKey, StringComparison.Ordinal);
        }

        return false;
    }

    private static bool TryReadProxyKey(HttpRequestData req, out string? providedKey)
    {
        if (req.Headers.TryGetValues("X-Proxy-Key", out var providedValues))
        {
            providedKey = providedValues.FirstOrDefault();
            return !string.IsNullOrWhiteSpace(providedKey);
        }

        if (req.Headers.TryGetValues("Authorization", out var authorizationValues))
        {
            var authorizationHeader = authorizationValues.FirstOrDefault();

            if (!string.IsNullOrWhiteSpace(authorizationHeader) &&
                AuthenticationHeaderValue.TryParse(authorizationHeader, out var parsedHeader) &&
                string.Equals(parsedHeader.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase))
            {
                providedKey = parsedHeader.Parameter;
                return !string.IsNullOrWhiteSpace(providedKey);
            }
        }

        foreach (var queryPart in req.Url.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separatorIndex = queryPart.IndexOf('=');
            var rawKey = separatorIndex >= 0 ? queryPart[..separatorIndex] : queryPart;

            if (!string.Equals(Uri.UnescapeDataString(rawKey), "proxyKey", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var rawValue = separatorIndex >= 0 ? queryPart[(separatorIndex + 1)..] : string.Empty;
            providedKey = Uri.UnescapeDataString(rawValue);
            return !string.IsNullOrWhiteSpace(providedKey);
        }

        providedKey = null;
        return false;
    }

    private Uri BuildBackendUri(HttpRequestData req, string path)
    {
        var suffix = string.IsNullOrWhiteSpace(path) ? string.Empty : "/" + path.TrimStart('/');
        return new Uri(_dataverseMcpUrl + suffix + BuildForwardQuery(req.Url.Query));
    }

    private static string BuildForwardQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return string.Empty;
        }

        var forwardedParts = new List<string>();

        foreach (var queryPart in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separatorIndex = queryPart.IndexOf('=');
            var rawKey = separatorIndex >= 0 ? queryPart[..separatorIndex] : queryPart;

            if (string.Equals(Uri.UnescapeDataString(rawKey), "proxyKey", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            forwardedParts.Add(queryPart);
        }

        return forwardedParts.Count == 0 ? string.Empty : "?" + string.Join("&", forwardedParts);
    }

    private static bool RequestCanHaveBody(string method)
        => !HttpMethods.IsGet(method)
           && !HttpMethods.IsHead(method)
           && !HttpMethods.IsOptions(method);

    private static void CopyRequestHeaders(HttpRequestData req, HttpRequestMessage backendRequest)
    {
        foreach (var header in req.Headers)
        {
            if (RequestHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            backendRequest.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static void CopyContentHeaders(HttpRequestData req, HttpRequestMessage backendRequest)
    {
        if (backendRequest.Content is null)
        {
            return;
        }

        foreach (var header in req.Headers)
        {
            if (RequestHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            backendRequest.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static void CopyResponseHeaders(HttpResponseMessage backendResponse, HttpResponseData response)
    {
        foreach (var header in backendResponse.Headers)
        {
            if (ResponseHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            response.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        foreach (var header in backendResponse.Content.Headers)
        {
            if (ResponseHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            response.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static class HttpMethods
    {
        public static bool IsGet(string method) => string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase);
        public static bool IsHead(string method) => string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
        public static bool IsOptions(string method) => string.Equals(method, "OPTIONS", StringComparison.OrdinalIgnoreCase);
    }
}