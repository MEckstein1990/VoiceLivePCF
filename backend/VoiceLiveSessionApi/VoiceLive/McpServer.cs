using System.Text.Json.Nodes;

namespace VoiceLiveSessionApi.VoiceLive;

/// <summary>MCP-Server eines Ziels, wie er in session.update eingetragen wird.</summary>
internal sealed record McpServer(string Url, string Label, IReadOnlyList<string> AllowedTools)
{
    /// <summary>
    /// Setzt diesen Server als MCP-Tool in eine session.update-Nachricht ein. Ohne Seiteneffekte –
    /// JSON rein, JSON raus. Null, wenn die Nachricht kein session.update ist.
    /// </summary>
    /// <exception cref="System.Text.Json.JsonException">Die Nachricht ist kein gültiges JSON.</exception>
    public byte[]? TryInjectInto(byte[] message, string mcpToken)
    {
        if (JsonNode.Parse(message) is not JsonObject root
            || root["type"] is not JsonValue type || !type.TryGetValue<string>(out var typeName)
            || typeName != "session.update"
            || root["session"] is not JsonObject session)
            return null;

        // Voice Agents verlangen den Sitzungstyp.
        session["type"] ??= "realtime";

        var mcpTool = new JsonObject
        {
            ["type"] = "mcp",
            ["server_label"] = Label,
            ["server_url"] = Url,
            // Ohne "Bearer ": Voice Live ergänzt das Präfix selbst.
            ["authorization"] = mcpToken,
            ["require_approval"] = "never"
        };
        if (AllowedTools.Count > 0)
            mcpTool["allowed_tools"] = new JsonArray([.. AllowedTools.Select(t => JsonValue.Create(t))]);

        if (session["tools"] is JsonArray tools)
            tools.Add(mcpTool);
        else
            session["tools"] = new JsonArray(mcpTool);

        return System.Text.Encoding.UTF8.GetBytes(root.ToJsonString());
    }
}
