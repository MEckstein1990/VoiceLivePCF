using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>
/// Schaltet die WebSocket-Unterstützung in der ASP.NET-Core-Pipeline des Workers ein. Den Proxy selbst
/// betreibt die <see cref="VoiceLiveWsRouteFunction"/>: Eine Middleware vor dem Functions-Host-Teil
/// der Pipeline würde die Anfrage beantworten, ohne dass der Host den Function-Aufruf zuordnen kann.
/// </summary>
internal sealed class VoiceLiveWsStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
            next(app);
        };
    }
}
