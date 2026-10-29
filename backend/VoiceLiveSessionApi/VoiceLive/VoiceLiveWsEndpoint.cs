using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using VoiceLiveSessionApi.Session;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Eingang des WebSocket-Proxys: prüft den Aufrufer, nimmt die Verbindung an und startet je
/// Verbindung eine <see cref="VoiceLiveSession"/>.
///
/// Authentifizierung: Token aus /api/voice-live/token als Query ?access_token=, geprüft über die
/// Policy "VoiceLiveWs" (Schema KoRaSessionToken). Agent-Parameter und User-Token stammen
/// ausschließlich aus dem Token.
/// </summary>
internal sealed class VoiceLiveWsEndpoint(
    IServiceProvider services,
    ILogger<VoiceLiveWsEndpoint> log)
{
    public async Task HandleAsync(HttpContext context)
    {
        if (await AuthorizeAsync(context) is not { } payload)
            return;

        using var client = await context.WebSockets.AcceptWebSocketAsync();
        var session = ActivatorUtilities.CreateInstance<VoiceLiveSession>(services, payload, client);
        await session.RunAsync(context.RequestAborted);
    }

    /// <summary>
    /// Wertet die Policy "VoiceLiveWs" aus. Explizit über IPolicyEvaluator, weil der Proxy
    /// vor dem Functions-Host läuft und es kein Endpoint-Routing (und damit kein [Authorize]) gibt.
    /// Gibt den Session-Payload zurück, oder null nachdem 401/403 gesetzt wurde.
    /// </summary>
    private async Task<SessionTokenPayload?> AuthorizeAsync(HttpContext context)
    {
        var requestServices = context.RequestServices;
        var policy = await requestServices.GetRequiredService<IAuthorizationPolicyProvider>()
            .GetPolicyAsync(SessionTokenAuthenticationDefaults.VoiceLiveWsPolicy)
            ?? throw new InvalidOperationException("Policy VoiceLiveWs nicht registriert");
        var evaluator = requestServices.GetRequiredService<IPolicyEvaluator>();

        var authentication = await evaluator.AuthenticateAsync(policy, context);
        var authorization = await evaluator.AuthorizeAsync(policy, authentication, context, resource: null);
        if (!authorization.Succeeded)
        {
            log.LogWarning("WS Proxy: Zugriff verweigert ({Reason})",
                authentication.Failure?.Message ?? (authorization.Challenged ? "kein Token" : "Policy nicht erfüllt"));
            context.Response.StatusCode = authorization.Challenged
                ? StatusCodes.Status401Unauthorized
                : StatusCodes.Status403Forbidden;
            return null;
        }

        // Aus dem übergebenen Context, nicht über IHttpContextAccessor: In einer Function ist dessen HttpContext null.
        return context.Features.Get<SessionTokenFeature>()?.Payload;
    }
}
