using Azure.AI.Agents.Persistent;
using Microsoft.Extensions.Logging;

namespace VoiceLiveSessionApi;

public sealed class FoundryApprovalWatcherService
{
    private readonly PersistentAgentsClient _agentClient;
    private readonly ILogger<FoundryApprovalWatcherService> _logger;

    public FoundryApprovalWatcherService(
        PersistentAgentsClient agentClient,
        ILogger<FoundryApprovalWatcherService> logger)
    {
        _agentClient = agentClient;
        _logger = logger;
    }

    public ApprovalSweepResult SweepPendingApprovals()
    {
        if (!IsEnabled())
        {
            return new ApprovalSweepResult(false, 0, 0, "APPROVAL_WATCHER_ENABLED is false");
        }

        var watchAgentId = ResolveAgentId();
        var threadLimit = GetIntSetting("POLL_LIMIT_THREADS", 100);
        var runLimit = GetIntSetting("POLL_LIMIT_RUNS", 100);
        var touchedRuns = 0;
        var approvedCalls = 0;

        foreach (var thread in _agentClient.Threads.GetThreads(limit: threadLimit, order: ListSortOrder.Descending))
        {
            foreach (var run in _agentClient.Runs.GetRuns(thread.Id, limit: runLimit, order: ListSortOrder.Descending))
            {
                if (!string.Equals(run.AssistantId, watchAgentId, StringComparison.Ordinal))
                {
                    continue;
                }

                if (run.Status != RunStatus.RequiresAction ||
                    run.RequiredAction is not SubmitToolApprovalAction toolApprovalAction)
                {
                    continue;
                }

                var approvals = new List<ToolApproval>();

                foreach (var toolCall in toolApprovalAction.SubmitToolApproval.ToolCalls)
                {
                    if (toolCall is not RequiredMcpToolCall mcpToolCall)
                    {
                        continue;
                    }

                    _logger.LogInformation("Approve MCP call {Name} {Arguments}", mcpToolCall.Name, mcpToolCall.Arguments);
                    approvals.Add(new ToolApproval(mcpToolCall.Id, approve: true));
                }

                if (approvals.Count == 0)
                {
                    continue;
                }

                _agentClient.Runs.SubmitToolOutputsToRun(thread.Id, run.Id, toolApprovals: approvals);
                touchedRuns++;
                approvedCalls += approvals.Count;
            }
        }

        return new ApprovalSweepResult(true, touchedRuns, approvedCalls, null);
    }

    private bool IsEnabled()
        => string.Equals(Environment.GetEnvironmentVariable("APPROVAL_WATCHER_ENABLED"), "true", StringComparison.OrdinalIgnoreCase);

    private string ResolveAgentId()
    {
        var watchAgentId = Environment.GetEnvironmentVariable("WATCH_AGENT_ID");

        if (!string.IsNullOrWhiteSpace(watchAgentId))
        {
            return watchAgentId;
        }

        var watchAgentName = Environment.GetEnvironmentVariable("WATCH_AGENT_NAME")
            ?? throw new InvalidOperationException("WATCH_AGENT_NAME missing");

        foreach (var agent in _agentClient.Administration.GetAgents(limit: 100, order: ListSortOrder.Descending))
        {
            if (string.Equals(agent.Name, watchAgentName, StringComparison.Ordinal))
            {
                return agent.Id;
            }
        }

        throw new InvalidOperationException($"Agent '{watchAgentName}' not found");
    }

    private static int GetIntSetting(string key, int fallback)
        => int.TryParse(Environment.GetEnvironmentVariable(key), out var value)
            ? Math.Max(1, value)
            : fallback;
}

public sealed record ApprovalSweepResult(bool Enabled, int TouchedRuns, int ApprovedCalls, string? Message);