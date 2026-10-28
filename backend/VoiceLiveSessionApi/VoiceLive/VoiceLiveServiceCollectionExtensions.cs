using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace VoiceLiveSessionApi.VoiceLive;

public static class VoiceLiveServiceCollectionExtensions
{
    /// <summary>
    /// Registriert den WebSocket-Proxy zu Voice Live. Setzt AddSession-Token und einen
    /// <see cref="Azure.Core.TokenCredential"/> voraus.
    /// </summary>
    public static IServiceCollection AddVoiceLive(this IServiceCollection services)
    {
        services.AddOptions<FoundryOptions>().BindConfiguration(FoundryOptions.SectionName);
        services.AddSingleton<VoiceLiveWsEndpoint>();
        services.AddSingleton<VoiceLiveUpstream>();
        services.AddSingleton<McpServerResolver>();

        // Als IStartupFilter: läuft VOR dem Azure-Functions-Host und kann WebSocket-Upgrades
        // abfangen, bevor der Functions-Host sie verarbeitet.
        services.AddSingleton<IStartupFilter, VoiceLiveWsStartupFilter>();
        return services;
    }
}
