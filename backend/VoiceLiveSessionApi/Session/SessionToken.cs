namespace VoiceLiveSessionApi.Session;

/// <summary>Inhalt des Session-Tokens. Liegt komplett verschlüsselt im Token.</summary>
/// <param name="TargetName">Name des AllowedTargets, gegen das beim Ausstellen des Session-Tokens geprüft wurde.</param>
public sealed record SessionTokenPayload(
    string TargetName,
    string AgentEndpoint,
    string AgentProjectName,
    string AgentId,
    string DataverseOrgUrl,
    string UserToken,
    string UserObjectId,
    string TenantId);
