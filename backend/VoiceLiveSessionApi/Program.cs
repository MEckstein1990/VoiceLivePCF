using System.Net;
using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using VoiceLiveSessionApi;

var host = new HostBuilder()
    .ConfigureFunctionsWebApplication()
    .ConfigureServices(services =>
    {
        services.AddSingleton(_ => new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.All
        }));
        services.AddSingleton<TokenCredential>(_ => new DefaultAzureCredential());
        services.AddSingleton(serviceProvider =>
        {
            var projectEndpoint = Environment.GetEnvironmentVariable("PROJECT_ENDPOINT")
                ?? throw new InvalidOperationException("PROJECT_ENDPOINT missing");
            return new PersistentAgentsClient(projectEndpoint, serviceProvider.GetRequiredService<TokenCredential>());
        });
        services.AddSingleton<DataverseTokenProvider>();
        services.AddSingleton<FoundryApprovalWatcherService>();
        // WebSocket-Proxy als IStartupFilter: wird VOR dem Azure-Functions-Host registriert
        // und kann WebSocket-Upgrades abfangen, bevor der Functions-Host sie verarbeitet.
        services.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, VoiceLiveWsStartupFilter>();
    })
    .Build();

host.Run();

