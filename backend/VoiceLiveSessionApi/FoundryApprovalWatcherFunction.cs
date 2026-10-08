using System.Net;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi;

public sealed class FoundryApprovalWatcherFunction
{
    private readonly FoundryApprovalWatcherService _watcherService;
    private readonly ILogger<FoundryApprovalWatcherFunction> _logger;

    public FoundryApprovalWatcherFunction(
        FoundryApprovalWatcherService watcherService,
        ILogger<FoundryApprovalWatcherFunction> logger)
    {
        _watcherService = watcherService;
        _logger = logger;
    }

    [Function("FoundryApprovalWatcherTimer")]
    public void RunTimer([TimerTrigger("*/15 * * * * *")] TimerInfo timerInfo)
    {
        var result = _watcherService.SweepPendingApprovals();
        _logger.LogInformation(
            "Approval watcher sweep finished. Enabled={Enabled}, TouchedRuns={TouchedRuns}, ApprovedCalls={ApprovedCalls}, Message={Message}",
            result.Enabled,
            result.TouchedRuns,
            result.ApprovedCalls,
            result.Message);
    }

    [Function("FoundryApprovalWatcherHttp")]
    public async Task<HttpResponseData> RunHttp(
        [HttpTrigger(AuthorizationLevel.Function, "post", Route = "approval-watcher/run")] HttpRequestData req)
    {
        var result = _watcherService.SweepPendingApprovals();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(result);
        return response;
    }
}