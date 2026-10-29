using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace VoiceLiveSessionApi.Dataverse;

/// <summary>
/// MCP-Server (Streamable HTTP, stateless) für die DataverseMcpTools (Dataverse.Client).
///
/// POST /api/dataverse/mcp
///   Header: Authorization: Bearer &lt;MCP-Token&gt; – so schickt Voice Live das "authorization"-Feld
///   der MCP-Tool-Definition. Das MCP-Token stellt die VoiceLiveSession aus.
///
/// Jede Methode (auch initialize und tools/list) wird zuerst vom
/// <see cref="DataverseIdentityResolver"/> geprüft, sonst 401. Das Protokoll selbst übernimmt das
/// MCP-SDK: je Request ein Server auf einem stateless Transport, damit es keine Sitzungen gibt,
/// die an einer Instanz hängen.
/// </summary>
public sealed class DataverseMcpFunction(
    DataverseIdentityResolver identityResolver,
    IOptions<McpServerOptions> serverOptions,
    ILoggerFactory loggerFactory)
{
    private readonly ILogger _logger = loggerFactory.CreateLogger<DataverseMcpFunction>();

    [Function("DataverseMcp")]
    public async Task<IActionResult> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "dataverse/mcp")] HttpRequest req,
        FunctionContext context)
    {
        var ct = context.CancellationToken;

        var identity = identityResolver.Resolve(req.Headers.Authorization);
        if (identity is null)
        {
            req.HttpContext.Response.Headers.WWWAuthenticate = "Bearer";
            return new UnauthorizedResult();
        }

        JsonRpcMessage? message;
        try
        {
            message = await JsonSerializer.DeserializeAsync<JsonRpcMessage>(req.Body, McpJsonUtilities.DefaultOptions, ct);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "MCP: Request ist kein gültiges JSON-RPC");
            return new BadRequestResult();
        }
        if (message is null)
            return new BadRequestResult();

        // Die Tools werden aus dem Scope dieser Invocation erzeugt (ScopeRequests = false) und
        // bekommen so die hier ermittelte Identität.
        context.InstanceServices.GetRequiredService<DataverseRequestContext>().Identity = identity;

        await using var transport = new StreamableHttpServerTransport(loggerFactory) { Stateless = true };
        await using var server = McpServer.Create(transport, serverOptions.Value, loggerFactory, context.InstanceServices);
        var running = server.RunAsync(ct);

        var response = req.HttpContext.Response;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        if (!await transport.HandlePostRequestAsync(message, response.Body, ct))
        {
            // Notification ohne Antwort.
            response.ContentType = null;
            return new StatusCodeResult(StatusCodes.Status202Accepted);
        }

        return new Microsoft.AspNetCore.Mvc.EmptyResult();
    }
}
