using Microsoft.AspNetCore.Http;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.DependencyInjection;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Eingang des WebSocket-Proxys: GET /api/voice-live/ws.
///
/// Der Proxy muss innerhalb einer Function laufen. Der Functions-Host leitet eine Anfrage nur dann an
/// den Worker weiter, wenn es eine Function mit dieser Route gibt (sonst 404 lokal, 500 in Azure), und
/// der Worker ordnet die Anfrage über die ASP.NET-Core-Integration dem Aufruf dieser Function zu.
/// Eine Middleware, die vorher antwortet, ohne die Function zu erreichen, führt nach 15 Sekunden zum
/// Timeout "Timed out waiting for the function start call".
///
/// Die Authentifizierung übernimmt der Proxy (Session-Token aus /api/voice-live/token), daher Anonymous.
/// </summary>
public sealed class VoiceLiveWsRouteFunction(IServiceProvider services)
{
    [Function("VoiceLiveWsRoute")]
    public async Task<IResult> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "voice-live/ws")] HttpRequest req)
    {
        var context = req.HttpContext;
        if (!context.WebSockets.IsWebSocketRequest)
            return Results.Text("WebSocket-Upgrade erforderlich.", statusCode: StatusCodes.Status426UpgradeRequired);

        await services.GetRequiredService<VoiceLiveWsEndpoint>().HandleAsync(context);

        // Antwort ist bei WebSocket (oder 401/403 aus dem Endpoint) bereits gesetzt.
        return Results.Empty;
    }
}
