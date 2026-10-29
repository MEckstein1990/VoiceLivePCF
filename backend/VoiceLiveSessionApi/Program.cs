using Azure.Core;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using VoiceLiveSessionApi.Agents;
using VoiceLiveSessionApi.Dataverse;
using VoiceLiveSessionApi.Session;
using VoiceLiveSessionApi.VoiceLive;

var host = new HostBuilder()
    .ConfigureFunctionsWebApplication()
    .ConfigureAppConfiguration(config => config
        .AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), optional: false)
        // Danach erneut, damit App-Settings Werte aus der Datei überschreiben (z.B. Dataverse__ClientId).
        .AddEnvironmentVariables())
    .ConfigureServices((context, services) =>
    {
        var credential = new DefaultAzureCredential();
        services.AddSingleton<TokenCredential>(credential);
        services.AddSessionToken(context.Configuration, credential);
        services.AddDataverse();
        services.AddVoiceLive();
        services.AddOptions<DeployAgentOptions>().BindConfiguration(DeployAgentOptions.SectionName);
    })
    .Build();

host.Run();

