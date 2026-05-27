using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Identity;

var appMode = Environment.GetEnvironmentVariable("APP_MODE")
    ?? "deploy-and-test";

var deployAgentOnly = string.Equals(appMode, "deploy-agent-only", StringComparison.OrdinalIgnoreCase);

var projectEndpoint = Environment.GetEnvironmentVariable("PROJECT_ENDPOINT")
    ?? "https://test-speechlive-mcp.services.ai.azure.com/api/projects/proj-default";

var foundryApiKey = Environment.GetEnvironmentVariable("FOUNDRY_API_KEY")
    ?? Environment.GetEnvironmentVariable("PROJECT_API_KEY")
    ?? Environment.GetEnvironmentVariable("AZURE_AI_API_KEY");

var modelDeploymentName = Environment.GetEnvironmentVariable("MODEL_DEPLOYMENT_NAME")
    ?? "gpt-4.1";

var agentName = Environment.GetEnvironmentVariable("AGENT_NAME")
    ?? "dataverse-proxy-playground-agent-v3";

var userPrompt = Environment.GetEnvironmentVariable("AGENT_USER_PROMPT")
    ?? "Bitte lies relevante Dataverse-Daten und gib mir alle Kunden aus deutschland.";

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

var usePersistentToolResourcesOnly = string.Equals(
    Environment.GetEnvironmentVariable("USE_PERSISTENT_TOOL_RESOURCES_ONLY"),
    "true",
    StringComparison.OrdinalIgnoreCase);

var mcpServerUrl = Environment.GetEnvironmentVariable("MCP_SERVER_URL")
    ?? "https://voicelivesessionapi-fgc4ebcfcnc3awef.germanywestcentral-01.azurewebsites.net/api/mcp";

var mcpServerLabel = Environment.GetEnvironmentVariable("MCP_SERVER_LABEL")
    ?? "dataverse";

var proxyApiKey = Environment.GetEnvironmentVariable("MCP_PROXY_API_KEY")
    ?? Environment.GetEnvironmentVariable("PROXY_API_KEY");

if (!string.IsNullOrWhiteSpace(proxyApiKey))
{
    var proxyUriBuilder = new UriBuilder(mcpServerUrl);
    var query = proxyUriBuilder.Query.TrimStart('?');
    var proxyKeyParameter = $"proxyKey={Uri.EscapeDataString(proxyApiKey)}";

    proxyUriBuilder.Query = string.IsNullOrWhiteSpace(query)
        ? proxyKeyParameter
        : $"{query}&{proxyKeyParameter}";

    mcpServerUrl = proxyUriBuilder.Uri.ToString();
}

if (!string.IsNullOrWhiteSpace(foundryApiKey))
{
    throw new InvalidOperationException(
        "FOUNDRY_API_KEY wird in diesem SDK-Pfad nicht unterstützt. Bitte per 'az login' anmelden und PROJECT_ENDPOINT setzen.");
}

PersistentAgentsClient agentClient = new(projectEndpoint, new AzureCliCredential());

if (string.Equals(appMode, "watch-approvals", StringComparison.OrdinalIgnoreCase))
{
    RunApprovalWatcher(agentClient);
    return;
}

// Für Proxy-Betrieb wird der Proxy-Key als Bearer-Header gesetzt.
// Für direkten Dataverse-Zugriff bleibt der bisherige Bearer-Flow als Fallback erhalten.
var dataverseBearerToken = Environment.GetEnvironmentVariable("DATAVERSE_BEARER_TOKEN");

if (string.IsNullOrWhiteSpace(proxyApiKey) && string.IsNullOrWhiteSpace(dataverseBearerToken))
{
    var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID")
        ?? throw new InvalidOperationException("AZURE_TENANT_ID fehlt");
    var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
        ?? throw new InvalidOperationException("AZURE_CLIENT_ID fehlt");
    var clientSecret = Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")
        ?? throw new InvalidOperationException("AZURE_CLIENT_SECRET fehlt");

    var dataverseAudience = Environment.GetEnvironmentVariable("DATAVERSE_SCOPE")
        ?? new Uri(mcpServerUrl).GetLeftPart(UriPartial.Authority) + "/.default";

    var credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    var tokenRequestContext = new TokenRequestContext(new[] { dataverseAudience });
    dataverseBearerToken = credential.GetToken(tokenRequestContext).Token;
}

// MCP-Tool definieren
MCPToolDefinition mcpTool = new(mcpServerLabel, mcpServerUrl);

// Optional: erlaubte Tools einschränken
mcpTool.AllowedTools.Add("list_tables");
mcpTool.AllowedTools.Add("describe_table");
mcpTool.AllowedTools.Add("read_query");
mcpTool.AllowedTools.Add("create_record");
mcpTool.AllowedTools.Add("update_record");

// MCP-Tool-Resource mit optionalen Headern und persistenten Approval-Regeln.
// Diese ToolResources werden direkt am Agent gespeichert, damit auch der Foundry Playground
// denselben MCP-Zugang und dieselben Approval-Regeln nutzt wie der SDK-Testlauf.
MCPToolResource mcpToolResource = new(mcpServerLabel);

if (!string.IsNullOrWhiteSpace(proxyApiKey))
{
    mcpToolResource.UpdateHeader("Authorization", $"Bearer {proxyApiKey}");
    Console.WriteLine("MCP-Ziel: Azure Proxy");
}
else if (!string.IsNullOrWhiteSpace(dataverseBearerToken))
{
    mcpToolResource.UpdateHeader("Authorization", $"Bearer {dataverseBearerToken}");
    Console.WriteLine("MCP-Ziel: Direktes Dataverse");
}

mcpToolResource.RequireApproval = BinaryData.FromObjectAsJson(new
{
    never = new
    {
        tool_names = new[] { "list_tables", "describe_table", "read_query" }
    }
});

ToolResources toolResources = mcpToolResource.ToToolResources();

// Agent anlegen oder aktualisieren
PersistentAgent? existingAgent = null;

foreach (var listedAgent in agentClient.Administration.GetAgents(limit: 100, order: ListSortOrder.Descending))
{
    if (string.Equals(listedAgent.Name, agentName, StringComparison.Ordinal))
    {
        existingAgent = listedAgent;
        break;
    }
}

PersistentAgent agent = existingAgent is null
    ? agentClient.Administration.CreateAgent(
        model: modelDeploymentName,
        name: agentName,
        instructions: agentInstructions,
        tools: [mcpTool],
        toolResources: toolResources,
        temperature: 0)
    : agentClient.Administration.UpdateAgent(
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

Console.WriteLine(existingAgent is null
    ? $"Agent erstellt: {agent.Name} ({agent.Id})"
    : $"Agent aktualisiert: {agent.Name} ({agent.Id})");
Console.WriteLine($"MCP-Server: {mcpServerUrl}");

if (deployAgentOnly)
{
    return;
}

// Thread anlegen
PersistentAgentThread thread = agentClient.Threads.CreateThread();

// User-Nachricht hinzufügen
agentClient.Messages.CreateMessage(
    thread.Id,
    MessageRole.User,
    userPrompt);

// Run starten
ThreadRun run = usePersistentToolResourcesOnly
    ? agentClient.Runs.CreateRun(thread, agent)
    : agentClient.Runs.CreateRun(thread, agent, toolResources);

Console.WriteLine(usePersistentToolResourcesOnly
    ? "Run-Modus: Nur persistente ToolResources"
    : "Run-Modus: Persistente + Run-ToolResources");

// Auf Abschluss / Approval warten
while (run.Status == RunStatus.Queued ||
       run.Status == RunStatus.InProgress ||
       run.Status == RunStatus.RequiresAction)
{
    Thread.Sleep(TimeSpan.FromSeconds(1));
    run = agentClient.Runs.GetRun(thread.Id, run.Id);

    if (run.Status == RunStatus.RequiresAction &&
        run.RequiredAction is SubmitToolApprovalAction toolApprovalAction)
    {
        var approvals = new List<ToolApproval>();

        foreach (var toolCall in toolApprovalAction.SubmitToolApproval.ToolCalls)
        {
            if (toolCall is RequiredMcpToolCall mcpToolCall)
            {
                Console.WriteLine($"Tool-Aufruf: {mcpToolCall.Name}");
                Console.WriteLine($"Argumente: {mcpToolCall.Arguments}");

                approvals.Add(new ToolApproval(mcpToolCall.Id, approve: true));
            }
        }

        if (approvals.Count > 0)
        {
            run = agentClient.Runs.SubmitToolOutputsToRun(
                thread.Id,
                run.Id,
                toolApprovals: approvals);
        }
    }
}

Console.WriteLine($"Run-Status: {run.Status}");
if (run.LastError is not null)
{
    Console.WriteLine($"Run-Fehler: {run.LastError.Code} - {run.LastError.Message}");
}

// Antwort lesen
var messages = agentClient.Messages.GetMessages(thread.Id, order: ListSortOrder.Ascending);

foreach (var message in messages)
{
    Console.WriteLine($"[{message.Role}]");

    foreach (var contentItem in message.ContentItems)
    {
        if (contentItem is MessageTextContent textItem)
        {
            Console.WriteLine(textItem.Text);
        }
    }

    Console.WriteLine();
}

void RunApprovalWatcher(PersistentAgentsClient client)
{
    var watchAgentId = Environment.GetEnvironmentVariable("WATCH_AGENT_ID");
    var watchAgentName = Environment.GetEnvironmentVariable("WATCH_AGENT_NAME")
        ?? agentName;
    var pollSeconds = int.TryParse(Environment.GetEnvironmentVariable("POLL_SECONDS"), out var parsedPollSeconds)
        ? Math.Max(parsedPollSeconds, 1)
        : 3;

    if (string.IsNullOrWhiteSpace(watchAgentId))
    {
        watchAgentId = ResolveAgentIdByName(client, watchAgentName)
            ?? throw new InvalidOperationException($"Agent '{watchAgentName}' nicht gefunden.");
    }

    Console.WriteLine($"Approval-Watcher aktiv für Agent: {watchAgentId}");
    Console.WriteLine($"Polling alle {pollSeconds}s");

    while (true)
    {
        var approvedCalls = 0;

        foreach (var thread in client.Threads.GetThreads(limit: 100, order: ListSortOrder.Descending))
        {
            foreach (var runItem in client.Runs.GetRuns(thread.Id, limit: 100, order: ListSortOrder.Descending))
            {
                if (!string.Equals(runItem.AssistantId, watchAgentId, StringComparison.Ordinal))
                {
                    continue;
                }

                if (runItem.Status != RunStatus.RequiresAction ||
                    runItem.RequiredAction is not SubmitToolApprovalAction toolApprovalAction)
                {
                    continue;
                }

                var approvals = new List<ToolApproval>();

                foreach (var toolCall in toolApprovalAction.SubmitToolApproval.ToolCalls)
                {
                    if (toolCall is RequiredMcpToolCall mcpToolCall)
                    {
                        Console.WriteLine($"Approve MCP-Call: {mcpToolCall.Name} {mcpToolCall.Arguments}");
                        approvals.Add(new ToolApproval(mcpToolCall.Id, approve: true));
                    }
                }

                if (approvals.Count == 0)
                {
                    continue;
                }

                client.Runs.SubmitToolOutputsToRun(thread.Id, runItem.Id, toolApprovals: approvals);
                approvedCalls += approvals.Count;
            }
        }

        if (approvedCalls > 0)
        {
            Console.WriteLine($"Genehmigt: {approvedCalls} Tool-Call(s) um {DateTimeOffset.Now:HH:mm:ss}");
        }

        Thread.Sleep(TimeSpan.FromSeconds(pollSeconds));
    }
}

string? ResolveAgentIdByName(PersistentAgentsClient client, string expectedAgentName)
{
    foreach (var existingAgent in client.Administration.GetAgents(limit: 100, order: ListSortOrder.Descending))
    {
        if (string.Equals(existingAgent.Name, expectedAgentName, StringComparison.Ordinal))
        {
            return existingAgent.Id;
        }
    }

    return null;
}