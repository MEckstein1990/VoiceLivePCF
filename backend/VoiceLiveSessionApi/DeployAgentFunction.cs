using Azure.AI.Agents.Persistent;
using Azure.Core;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi;

/// <summary>
/// Erstellt oder aktualisiert den Foundry-Agenten.
///
/// POST /api/deploy-agent
///   → Agent erstellen/aktualisieren, Agent-ID zurückgeben
///
/// Benötigte Environment Variables (zusätzlich zu den bestehenden):
///   PROJECT_ENDPOINT        – Azure AI Foundry Projekt-URL
///   MODEL_DEPLOYMENT_NAME   – Modell (z.B. gpt-4.1)
///   AGENT_NAME              – Name des Agenten
///   AGENT_INSTRUCTIONS      – (optional) System-Instructions
///   MCP_SERVER_URL          – URL des MCP-Endpunkts (Standard: dieser Service /api/mcp)
///   MCP_SERVER_LABEL        – Label für den MCP-Server (Standard: dataverse)
///   PROXY_API_KEY           – API-Key für den MCP-Proxy (optional)
/// </summary>
public sealed class DeployAgentFunction
{
    private readonly TokenCredential _credential;
    private readonly ILogger<DeployAgentFunction> _logger;
    private readonly string? _proxyApiKey;

    public DeployAgentFunction(
        TokenCredential credential,
        ILogger<DeployAgentFunction> logger)
    {
        _credential = credential;
        _logger = logger;
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");
    }

    [Function("DeployAgent")]
    public async Task<HttpResponseData> Deploy(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "deploy-agent")]
        HttpRequestData req,
        FunctionContext context)
    {
        // Proxy-Key prüfen
        if (!string.IsNullOrWhiteSpace(_proxyApiKey))
        {
            var key = req.Headers.TryGetValues("X-Proxy-Key", out var headerValues)
                ? headerValues.FirstOrDefault()
                : req.Url.Query.Split('&')
                    .FirstOrDefault(q => q.StartsWith("key=", StringComparison.OrdinalIgnoreCase))
                    ?.Substring(4);

            if (!string.Equals(key, _proxyApiKey, StringComparison.Ordinal))
            {
                var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
                await unauthorized.WriteStringAsync("Unauthorized");
                return unauthorized;
            }
        }

        try
        {
            var projectEndpoint = Environment.GetEnvironmentVariable("PROJECT_ENDPOINT")
                ?? "https://test-speechlive-mcp.services.ai.azure.com/api/projects/proj-default";

            var modelDeploymentName = Environment.GetEnvironmentVariable("MODEL_DEPLOYMENT_NAME")
                ?? "gpt-4.1";

            var agentName = Environment.GetEnvironmentVariable("AGENT_NAME")
                ?? "dataverse-proxy-playground-agent-v3";

            var agentInstructions = Environment.GetEnvironmentVariable("AGENT_INSTRUCTIONS")
                ?? """
                Du bist ein Assistent für transkribierte Spracheingaben.
                Nutze die MCP-Tools nur wenn nötig.
                Bevorzuge Lesezugriffe.
                Schreibzugriffe nur nach expliziter Freigabe.

                Für MCP-Tools gilt zwingend:
                - Übergib niemals leere Strings als Tool-Argumente.
                - Wenn ein optionales Argument unbekannt ist, lasse es weg statt es als leeren String zu senden.
                - Für list_tables setze scope nur, wenn du einen konkreten nicht-leeren Wert hast.
                - Wenn du nach Kunden suchst, beginne mit list_tables ohne leeren scope und prüfe danach account oder contact.
                - Wenn Deutschland keine Treffer liefert, versuche zusätzlich Germany.
                """;

            var mcpServerLabel = Environment.GetEnvironmentVariable("MCP_SERVER_LABEL")
                ?? "dataverse";

            // Standard: dieser Service selbst als MCP-Endpunkt
            var mcpServerUrl = Environment.GetEnvironmentVariable("MCP_SERVER_URL")
                ?? $"{req.Url.GetLeftPart(UriPartial.Authority)}/api/mcp";

            // Proxy-Key an MCP-URL anhängen
            if (!string.IsNullOrWhiteSpace(_proxyApiKey))
            {
                var uriBuilder = new UriBuilder(mcpServerUrl);
                var query = uriBuilder.Query.TrimStart('?');
                var keyParam = $"proxyKey={Uri.EscapeDataString(_proxyApiKey)}";
                uriBuilder.Query = string.IsNullOrWhiteSpace(query) ? keyParam : $"{query}&{keyParam}";
                mcpServerUrl = uriBuilder.Uri.ToString();
            }

            _logger.LogInformation("Deploying agent '{AgentName}' to {ProjectEndpoint}", agentName, projectEndpoint);

            PersistentAgentsClient agentClient = new(projectEndpoint, _credential);

            // MCP-Tool definieren
            MCPToolDefinition mcpTool = new(mcpServerLabel, mcpServerUrl);
            mcpTool.AllowedTools.Add("list_tables");
            mcpTool.AllowedTools.Add("describe_table");
            mcpTool.AllowedTools.Add("read_query");
            mcpTool.AllowedTools.Add("create_record");
            mcpTool.AllowedTools.Add("update_record");

            MCPToolResource mcpToolResource = new(mcpServerLabel);
            mcpToolResource.UpdateHeader("Authorization", $"Bearer {_proxyApiKey ?? string.Empty}");
            mcpToolResource.RequireApproval = BinaryData.FromObjectAsJson(new
            {
                never = new
                {
                    tool_names = new[] { "list_tables", "describe_table", "read_query" }
                }
            });

            ToolResources toolResources = mcpToolResource.ToToolResources();

            // Existierenden Agenten suchen
            PersistentAgent? existingAgent = null;
            await foreach (var listedAgent in agentClient.Administration.GetAgentsAsync(limit: 100, order: ListSortOrder.Descending))
            {
                if (string.Equals(listedAgent.Name, agentName, StringComparison.Ordinal))
                {
                    existingAgent = listedAgent;
                    break;
                }
            }

            PersistentAgent agent = existingAgent is null
                ? await agentClient.Administration.CreateAgentAsync(
                    model: modelDeploymentName,
                    name: agentName,
                    instructions: agentInstructions,
                    tools: [mcpTool],
                    toolResources: toolResources,
                    temperature: 0)
                : await agentClient.Administration.UpdateAgentAsync(
                    existingAgent.Id,
                    model: modelDeploymentName,
                    name: agentName,
                    description: existingAgent.Description,
                    instructions: agentInstructions,
                    tools: [mcpTool],
                    toolResources: toolResources,
                    temperature: 0,
                    topP: existingAgent.TopP,
                    responseFormat: existingAgent.ResponseFormat,
                    metadata: existingAgent.Metadata);

            var action = existingAgent is null ? "erstellt" : "aktualisiert";
            _logger.LogInformation("Agent {Action}: {Name} ({Id})", action, agent.Name, agent.Id);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                action,
                agentId = agent.Id,
                agentName = agent.Name,
                mcpServerUrl
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
}
