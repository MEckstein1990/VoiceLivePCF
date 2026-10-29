using Azure.Core;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi.Agents;

/// <summary>
/// Erstellt oder aktualisiert den Foundry Voice Agent (kind: voice) mit der Audio-Konfiguration,
/// die das PCF-Control erwartet.
///
/// POST /api/deploy-agent
///   → Agent-Version anlegen, Name und Version zurückgeben
///
/// Konfiguration: Abschnitt "DeployAgent" (siehe <see cref="DeployAgentOptions"/>).
///
/// Authentifizierung: Azure Function Key (AuthorizationLevel.Function).
///
/// Jeder Aufruf setzt die Instructions aus der Konfiguration (ohne Wert: Standardtext in <see cref="DeployAgentOptions"/>). Ein Agent mit anderen Instructions
/// bekommt also eine neue Version, die sofort die aktuelle ist.
/// </summary>
public sealed class DeployAgentFunction
{
    private const string Scope = "https://ai.azure.com/.default";

    // Voice Agents sind in Foundry noch Preview und brauchen dieses Feature-Flag.
    private const string FoundryFeatures = "VoiceAgents=V1Preview";

    private static readonly HttpClient Http = new();

    private readonly TokenCredential _credential;
    private readonly ILogger<DeployAgentFunction> _logger;
    private readonly DeployAgentOptions _options;

    public DeployAgentFunction(
        TokenCredential credential,
        IOptions<DeployAgentOptions> options,
        ILogger<DeployAgentFunction> logger)
    {
        _credential = credential;
        _options = options.Value;
        _logger = logger;
    }

    [Function("DeployAgent")]
    public async Task<HttpResponseData> Deploy(
        [HttpTrigger(AuthorizationLevel.Function, "post", Route = "deploy-agent")]
        HttpRequestData req,
        FunctionContext context)
    {
        try
        {
            var ct = context.CancellationToken;
            var agentName = _options.AgentName;
            var agentUrl = $"{_options.ProjectEndpoint.TrimEnd('/')}/agents/{Uri.EscapeDataString(agentName)}";

            _logger.LogInformation("Deploying voice agent '{AgentName}' to {ProjectEndpoint}", agentName, _options.ProjectEndpoint);

            var token = await _credential.GetTokenAsync(new TokenRequestContext([Scope]), ct);

            // Bisherige Version (null: den Agenten gibt es noch nicht). Foundry legt bei einer
            // unveränderten Definition keine neue Version an, daran erkennt man "unverändert".
            var previousVersion = await GetLatestVersionAsync(agentUrl, token, ct);

            using var request = CreateRequest(HttpMethod.Post, $"{agentUrl}/versions?api-version=v1", token);
            request.Content = new StringContent(
                JsonSerializer.Serialize(new { definition = BuildDefinition() }), Encoding.UTF8, "application/json");
            using var created = await Http.SendAsync(request, ct);
            var createdBody = await created.Content.ReadAsStringAsync(ct);
            if (!created.IsSuccessStatusCode)
                throw new InvalidOperationException($"Foundry antwortete {(int)created.StatusCode}: {createdBody}");

            var version = JsonDocument.Parse(createdBody).RootElement.GetProperty("version").GetString();

            var action = previousVersion is null ? "erstellt"
                : previousVersion == version ? "unverändert"
                : "aktualisiert";
            _logger.LogInformation("Voice Agent {Action}: {Name}, Version {Version}", action, agentName, version);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                action,
                agentId = agentName,
                agentName,
                version
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Fehler beim Deployen des Agenten");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteStringAsync(ex.Message);
            return error;
        }
    }

    /// <summary>
    /// Definition des Voice Agents. Die Werte entsprechen dem session.update des Controls:
    /// Turn-Detection-Typ und Echo-Cancellation lassen sich in der Session nicht mehr ändern und
    /// müssen deshalb hier stimmen. Das Control sendet Mono ohne Referenzkanal
    /// (USE_LIVE_REFERENCE_AEC = false), also Echo-Cancellation mit Server-Referenz und 1 Kanal.
    /// Ohne greeting spricht der Agent nicht von sich aus, die Begrüßung kommt vom Control.
    /// </summary>
    private object BuildDefinition() => new
    {
        kind = "voice",
        model_type = "managed",
        model = _options.ModelDeploymentName,
        instructions = _options.Instructions,
        output_modalities = new[] { "audio" },
        audio = new
        {
            input = new
            {
                format = new { type = "audio/pcm", rate = 24000 },
                noise_reduction = new { type = "azure_deep_noise_suppression" },
                turn_detection = new
                {
                    type = "azure_semantic_vad_multilingual",
                    threshold = 0.5,
                    prefix_padding_ms = 300,
                    silence_duration_ms = 2000,
                    languages = new[] { _options.Language },
                    remove_filler_words = false,
                    interrupt_response = true,
                    auto_truncate = false
                },
                echo_cancellation = new { type = "server_echo_cancellation" },
                transcription = new { model = "azure-speech", language = _options.Language }
            },
            output = new
            {
                format = new { type = "audio/pcm", rate = 24000 },
                voice = _options.VoiceName,
                // Ohne voice_type gilt die Stimme als OpenAI-Stimme und wird nicht als Azure-Stimme gesetzt.
                voice_type = "azure-standard"
            }
        }
    };

    /// <summary>Neueste Version des Agenten oder null, wenn es ihn noch nicht gibt.</summary>
    private static async Task<string?> GetLatestVersionAsync(string agentUrl, AccessToken token, CancellationToken ct)
    {
        using var request = CreateRequest(HttpMethod.Get, $"{agentUrl}?api-version=v1", token);
        using var response = await Http.SendAsync(request, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
            return null;

        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Foundry antwortete {(int)response.StatusCode}: {body}");

        return JsonDocument.Parse(body).RootElement
            .GetProperty("versions").GetProperty("latest").GetProperty("version").GetString();
    }

    private static HttpRequestMessage CreateRequest(HttpMethod method, string url, AccessToken token)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        request.Headers.Add("Foundry-Features", FoundryFeatures);
        return request;
    }
}
