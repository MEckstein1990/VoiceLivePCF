using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AuthorizationLevel = Microsoft.Azure.Functions.Worker.AuthorizationLevel;
using HttpTriggerAttribute = Microsoft.Azure.Functions.Worker.HttpTriggerAttribute;

namespace VoiceLiveSessionApi;

public sealed class DataverseMcpProxy
{
    private static readonly HashSet<string> RequestHeadersToSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "Authorization",
        "Connection",
        "Content-Length",
        "Host",
        "Transfer-Encoding",
        "X-Proxy-Key",
        // User-Auth-Header: werden vom Proxy ausgewertet, nicht an Dataverse weitergeleitet
        "X-User-Token",
        "X-Dataverse-Caller-Id"
    };

    private static readonly HashSet<string> ResponseHeadersToSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection",
        "Content-Length",
        "Keep-Alive",
        "Set-Cookie",
        "Transfer-Encoding"
    };

    // Tool-Name-Präfixe, die als Abfrage-Tools gelten und einen User-Filter erhalten.
    // Erweiterbar via DATAVERSE_QUERY_TOOL_PREFIXES (kommasepariert).
    private static readonly string[] DefaultQueryToolPrefixes =
        ["read_query", "search_data"];

    private readonly HttpClient _httpClient;
    private readonly DataverseTokenProvider _tokenProvider;
    private readonly UserSessionStore _sessionStore;
    private readonly ILogger<DataverseMcpProxy> _logger;
    private readonly string _dataverseMcpUrl;
    private readonly string? _proxyApiKey;

    // Option 3 – Filter-Injektion
    // DATAVERSE_INJECT_USER_FILTER=true      → aktiviert die Filter-Logik
    // DATAVERSE_USER_FILTER_FIELD            → SQL-Feldname für Owner (Standard: ownerid)
    // DATAVERSE_EXTRA_USER_FIELDS            → kommaseparierte zusätzliche Felder, die per OR verknüpft werden (Standard: createdby,modifiedby)
    //                                          Leer lassen um nur ownerid zu filtern.
    // DATAVERSE_ACCOUNT_TABLE               → Tabellenname für Kunden (Standard: account)
    // DATAVERSE_CONTACT_TABLE               → Tabellenname für Kontakte (Standard: contact)
    // DATAVERSE_CONTACT_PARENT_FIELD        → Parent-Feld auf contact (Standard: parentcustomerid)
    // DATAVERSE_QUERY_TOOL_PREFIXES          → kommaseparierte Tool-Präfixe (optional)
    // DATAVERSE_WRITE_TOOL_PREFIXES           → Tools bei denen ownerid forciert wird (Standard: create_record)
    //                                          Leer lassen um ownerid-Injektion bei Writes zu deaktivieren.
    private readonly bool _injectUserFilter;
    private readonly string _userFilterField;
    private readonly string[] _extraUserFields;
    private readonly string[] _writeToolPrefixes;
    private readonly string _accountTable;
    private readonly string _contactTable;
    private readonly string _contactParentField;
    private readonly string[] _queryToolPrefixes;

    public DataverseMcpProxy(
        HttpClient httpClient,
        DataverseTokenProvider tokenProvider,
        UserSessionStore sessionStore,
        ILogger<DataverseMcpProxy> logger)
    {
        _httpClient = httpClient;
        _tokenProvider = tokenProvider;
        _sessionStore = sessionStore;
        _logger = logger;
        _dataverseMcpUrl = (Environment.GetEnvironmentVariable("DATAVERSE_MCP_URL")
            ?? throw new InvalidOperationException("DATAVERSE_MCP_URL missing")).TrimEnd('/');
        _proxyApiKey = Environment.GetEnvironmentVariable("PROXY_API_KEY");

        _injectUserFilter = string.Equals(
            Environment.GetEnvironmentVariable("DATAVERSE_INJECT_USER_FILTER"),
            "true", StringComparison.OrdinalIgnoreCase);
        _userFilterField = Environment.GetEnvironmentVariable("DATAVERSE_USER_FILTER_FIELD")
            ?? "ownerid";
        var extraFields = Environment.GetEnvironmentVariable("DATAVERSE_EXTRA_USER_FIELDS");
        _extraUserFields = extraFields is null
            ? ["createdby", "modifiedby"]
            : extraFields.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        _accountTable = Environment.GetEnvironmentVariable("DATAVERSE_ACCOUNT_TABLE")
            ?? "account";
        _contactTable = Environment.GetEnvironmentVariable("DATAVERSE_CONTACT_TABLE")
            ?? "contact";
        _contactParentField = Environment.GetEnvironmentVariable("DATAVERSE_CONTACT_PARENT_FIELD")
            ?? "parentcustomerid";
        var customPrefixes = Environment.GetEnvironmentVariable("DATAVERSE_QUERY_TOOL_PREFIXES");
        _queryToolPrefixes = string.IsNullOrWhiteSpace(customPrefixes)
            ? DefaultQueryToolPrefixes
            : customPrefixes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var writePrefixes = Environment.GetEnvironmentVariable("DATAVERSE_WRITE_TOOL_PREFIXES");
        _writeToolPrefixes = writePrefixes is null
            ? ["create_record"]
            : writePrefixes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    [Function("DataverseMcpProxyRoot")]
    public Task<HttpResponseData> ProxyRoot(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", "put", "patch", "delete", "options", Route = "mcp")] HttpRequestData req,
        FunctionContext context)
        => ProxyAsync(req, string.Empty, context.CancellationToken);

    [Function("DataverseMcpProxyPath")]
    public Task<HttpResponseData> ProxyPath(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", "put", "patch", "delete", "options", Route = "mcp/{*path}")] HttpRequestData req,
        string? path,
        FunctionContext context)
        => ProxyAsync(req, path ?? string.Empty, context.CancellationToken);

    private async Task<HttpResponseData> ProxyAsync(HttpRequestData req, string path, CancellationToken cancellationToken)
    {
        if (!IsProxyKeyValid(req))
        {
            var unauthorized = req.CreateResponse(HttpStatusCode.Unauthorized);
            await unauthorized.WriteStringAsync("Invalid proxy key.", cancellationToken);
            return unauthorized;
        }

        // ── Authentifizierungsmodus bestimmen ─────────────────────────────────────────
        //
        // Option 1 – OBO (On-Behalf-Of):
        //   Header X-User-Token: <AAD-Access-Token des Users>
        //   → Token wird gegen ein Dataverse-Token des Users getauscht.
        //   → Dataverse erzwingt die eigenen Security Roles des Users.
        //   → Voraussetzung: AppReg hat delegierte Berechtigung "user_impersonation" auf D365.
        //
        // Option 2 – Impersonation via MSCRMCallerID:
        //   Header X-Dataverse-Caller-Id: <Dataverse SystemUser-GUID des Users>
        //   → Service-Principal-Token, aber Dataverse führt den Call im Kontext des Users aus.
        //   → Voraussetzung: AppReg/Service-Principal hat Dataverse-Privilege "prvActOnBehalfOfAnotherUser".
        //   → Die GUID liefert das PCF als context.userSettings.userId.
        //
        // Fallback – Service Principal:
        //   Kein User-Header → bisheriges Verhalten (volle Rechte des Service Principals).

        string token;
        string? mscrmCallerId = null;
        string callerLabel;

        // Diagnose: alle eingehenden Header von Voice Live loggen (nur Header-Namen + ob Authorization vorhanden)
        var hasAuthHeader = req.Headers.Contains("Authorization");
        var authHeaderPreview = hasAuthHeader
            ? (req.Headers.GetValues("Authorization").FirstOrDefault() ?? "")
            : "(nicht vorhanden)";
        _logger.LogInformation(
            "MCP Proxy eingehend: Methode={Method} Pfad={Path} Query={Query} Authorization={AuthPreview}",
            req.Method, path, req.Url.Query,
            authHeaderPreview.Length > 30 ? authHeaderPreview[..30] + "..." : authHeaderPreview);

        // Priorität 0: Bearer-Token von Voice Live (aus session.update MCP authorization-Feld)
        // VoiceLiveWsStartupFilter injiziert {authorization: userToken} in session.update.
        // Voice Live sendet diesen Token dann als Authorization: Bearer {userToken} an diesen Endpunkt.
        // Da der Token bereits ein Dataverse-Token ist (MSAL scope=crm/.default), kann er direkt
        // als Bearer-Token gegen Dataverse verwendet werden — kein OBO nötig.
        if (req.Headers.TryGetValues("Authorization", out var incomingAuthValues)
            && incomingAuthValues.FirstOrDefault() is { } incomingAuth
            && incomingAuth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            && incomingAuth.Length > "Bearer ".Length)
        {
            token = incomingAuth["Bearer ".Length..];
            callerLabel = "(user-token)";
            _logger.LogInformation("MCP Proxy: Dataverse User-Token aus Voice Live MCP authorization verwendet");
        }
        // Option 1: OBO via X-User-Token Header
        else if (req.Headers.TryGetValues("X-User-Token", out var userTokenValues)
            && !string.IsNullOrWhiteSpace(userTokenValues.FirstOrDefault()))
        {
            token = await _tokenProvider.GetAccessTokenOnBehalfOfAsync(
                userTokenValues.First(), cancellationToken);
            callerLabel = "(user-obo)";
        }
        else
        {
            // Fallback: Service-Principal-Token
            token = await _tokenProvider.GetAccessTokenAsync(cancellationToken);

            // Option 2: Impersonation via MSCRMCallerID (Header, Query-Param oder Session-Store)
            if (req.Headers.TryGetValues("X-Dataverse-Caller-Id", out var callerIdValues))
            {
                mscrmCallerId = callerIdValues.FirstOrDefault();
            }
            else if (ExtractQueryParam(req.Url.Query, "caller-id") is { } directCallerId)
            {
                mscrmCallerId = directCallerId;
            }
            else if (ExtractQueryParam(req.Url.Query, "session") is { } sessionId)
            {
                // Session-Store-Lookup: WsProxy hat die User-GUID beim WebSocket-Aufbau gespeichert.
                mscrmCallerId = _sessionStore.GetUserId(sessionId);
            }
            else if (_sessionStore.GetCurrentCallerId() is { } storedCallerId
                && !string.IsNullOrWhiteSpace(storedCallerId))
            {
                // Globaler Fallback: letzter aktiver WS-User (für Voice Live das Standard-Szenario,
                // da Voice Live keine session-ID an den MCP-Proxy mitschickt).
                mscrmCallerId = storedCallerId;
            }
            callerLabel = mscrmCallerId is not null ? $"(impersonation:{mscrmCallerId})" : "(service-principal)";
        }

        var backendUri = BuildBackendUri(req, path);

        using var backendRequest = new HttpRequestMessage(new HttpMethod(req.Method), backendUri);
        CopyRequestHeaders(req, backendRequest);
        backendRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        if (!string.IsNullOrWhiteSpace(mscrmCallerId))
        {
            backendRequest.Headers.TryAddWithoutValidation("MSCRMCallerID", mscrmCallerId);
        }

        if (RequestCanHaveBody(req.Method))
        {
            // Option 3 – Filter-Injektion:
            // filterUserId unabhängig vom Auth-Pfad bestimmen:
            // mscrmCallerId ist nur im Service-Principal-Pfad gesetzt.
            // Im Priority-0-Pfad (Bearer-Token) wird caller-id direkt aus dem URL-Parameter gelesen.
            var filterUserId = mscrmCallerId
                ?? ExtractQueryParam(req.Url.Query, "caller-id")
                ?? _sessionStore.GetCurrentCallerId();
            _logger.LogInformation(
                "[FILTER-DIAG] injectUserFilter={Inject} filterUserId={UserId} mscrmCallerId={CrmId} storedCallerId={Stored}",
                _injectUserFilter, filterUserId ?? "(null)", mscrmCallerId ?? "(null)",
                _sessionStore.GetCurrentCallerId() ?? "(null)");

            if (_injectUserFilter && !string.IsNullOrWhiteSpace(filterUserId))
            {
                var storedCtx = _sessionStore.GetCurrentUserContext();
                var userCtx = (storedCtx?.UserId == filterUserId)
                    ? storedCtx!
                    : new UserContext(filterUserId, [], []);

                var filteredBody = await InjectUserFilterAsync(
                    req.Body, userCtx, _userFilterField, _extraUserFields,
                    _accountTable, _contactTable, _contactParentField,
                    _queryToolPrefixes, _writeToolPrefixes, cancellationToken);
                backendRequest.Content = new StreamContent(filteredBody);
            }
            else
            {
                backendRequest.Content = new StreamContent(req.Body);
            }
            CopyContentHeaders(req, backendRequest);
        }

        using var backendResponse = await _httpClient.SendAsync(
            backendRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        var response = req.CreateResponse(backendResponse.StatusCode);
        CopyResponseHeaders(backendResponse, response);

        await using var backendStream = await backendResponse.Content.ReadAsStreamAsync(cancellationToken);
        await backendStream.CopyToAsync(response.Body, cancellationToken);

        _logger.LogInformation(
            "Relayed MCP request {Method} {Path} -> {StatusCode} (callerId={CallerId})",
            req.Method,
            backendUri.PathAndQuery,
            (int)backendResponse.StatusCode,
            callerLabel);

        return response;
    }

    private bool IsProxyKeyValid(HttpRequestData req)
    {
        if (string.IsNullOrWhiteSpace(_proxyApiKey))
        {
            return true;
        }

        if (TryReadProxyKey(req, out var providedKey))
        {
            return string.Equals(providedKey, _proxyApiKey, StringComparison.Ordinal);
        }

        return false;
    }

    private static bool TryReadProxyKey(HttpRequestData req, out string? providedKey)
    {
        if (req.Headers.TryGetValues("X-Proxy-Key", out var providedValues))
        {
            providedKey = providedValues.FirstOrDefault();
            return !string.IsNullOrWhiteSpace(providedKey);
        }

        if (req.Headers.TryGetValues("Authorization", out var authorizationValues))
        {
            var authorizationHeader = authorizationValues.FirstOrDefault();

            if (!string.IsNullOrWhiteSpace(authorizationHeader) &&
                AuthenticationHeaderValue.TryParse(authorizationHeader, out var parsedHeader) &&
                string.Equals(parsedHeader.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase))
            {
                providedKey = parsedHeader.Parameter;
                return !string.IsNullOrWhiteSpace(providedKey);
            }
        }

        foreach (var queryPart in req.Url.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separatorIndex = queryPart.IndexOf('=');
            var rawKey = separatorIndex >= 0 ? queryPart[..separatorIndex] : queryPart;

            if (!string.Equals(Uri.UnescapeDataString(rawKey), "proxyKey", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var rawValue = separatorIndex >= 0 ? queryPart[(separatorIndex + 1)..] : string.Empty;
            providedKey = Uri.UnescapeDataString(rawValue);
            return !string.IsNullOrWhiteSpace(providedKey);
        }

        providedKey = null;
        return false;
    }

    private Uri BuildBackendUri(HttpRequestData req, string path)
    {
        var suffix = string.IsNullOrWhiteSpace(path) ? string.Empty : "/" + path.TrimStart('/');
        return new Uri(_dataverseMcpUrl + suffix + BuildForwardQuery(req.Url.Query));
    }

    private static string BuildForwardQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return string.Empty;
        }

        var forwardedParts = new List<string>();

        foreach (var queryPart in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separatorIndex = queryPart.IndexOf('=');
            var rawKey = Uri.UnescapeDataString(separatorIndex >= 0 ? queryPart[..separatorIndex] : queryPart);

            // Proxy-interne Query-Params nicht an Dataverse weiterleiten
            if (string.Equals(rawKey, "proxyKey", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rawKey, "caller-id", StringComparison.OrdinalIgnoreCase)
                || string.Equals(rawKey, "session", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            forwardedParts.Add(queryPart);
        }

        return forwardedParts.Count == 0 ? string.Empty : "?" + string.Join("&", forwardedParts);
    }

    private static bool RequestCanHaveBody(string method)
        => !HttpMethods.IsGet(method)
           && !HttpMethods.IsHead(method)
           && !HttpMethods.IsOptions(method);

    private static void CopyRequestHeaders(HttpRequestData req, HttpRequestMessage backendRequest)
    {
        foreach (var header in req.Headers)
        {
            if (RequestHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            backendRequest.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static void CopyContentHeaders(HttpRequestData req, HttpRequestMessage backendRequest)
    {
        if (backendRequest.Content is null)
        {
            return;
        }

        foreach (var header in req.Headers)
        {
            if (RequestHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            backendRequest.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    private static void CopyResponseHeaders(HttpResponseMessage backendResponse, HttpResponseData response)
    {
        foreach (var header in backendResponse.Headers)
        {
            if (ResponseHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            response.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        foreach (var header in backendResponse.Content.Headers)
        {
            if (ResponseHeadersToSkip.Contains(header.Key))
            {
                continue;
            }

            response.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
    }

    /// <summary>
    /// Parst den JSON-RPC Body und injiziert in tools/call-Requests für das Dataverse-Tool
    /// "read_query" eine entity-spezifische SQL-WHERE-Klausel:
    ///
    ///   account  → ownerid IN (userId, teamId1, teamId2, ...)
    ///   contact  → ownerid IN (...) OR parentcustomerid IN (accountId1, accountId2, ...)
    ///   andere   → ownerid IN (userId, teamId1, ...) [z.B. KoRa Protokolle]
    ///
    /// Bei Parse-Fehlern oder nicht-passenden Requests wird der Body unverändert durchgeleitet.
    /// </summary>
    private static async Task<Stream> InjectUserFilterAsync(
        Stream body, UserContext userCtx, string ownerField, string[] extraUserFields,
        string accountTable, string contactTable, string contactParentField,
        string[] queryToolPrefixes, string[] writeToolPrefixes, CancellationToken ct)
    {
        string json;
        using (var sr = new StreamReader(body, Encoding.UTF8, leaveOpen: false))
            json = await sr.ReadToEndAsync(ct);

        try
        {
            var root = JsonNode.Parse(json) as JsonObject;
            if (root is null) return ToStream(json);

            if (root["method"]?.GetValue<string>() != "tools/call") return ToStream(json);

            var paramsObj = root["params"] as JsonObject;
            var toolName  = paramsObj?["name"]?.GetValue<string>() ?? string.Empty;

            // arguments kann je nach Foundry-Version ein JsonObject ODER ein JSON-kodierter String sein.
            JsonObject? arguments;
            bool argumentsWasString = false;
            var rawArguments = paramsObj?["arguments"];
            if (rawArguments is JsonObject directObj)
            {
                arguments = directObj;
            }
            else if (rawArguments?.GetValueKind() == System.Text.Json.JsonValueKind.String)
            {
                // Foundry serialisiert arguments manchmal als JSON-String → erneut parsen
                arguments = JsonNode.Parse(rawArguments.GetValue<string>()) as JsonObject;
                argumentsWasString = arguments is not null;
            }
            else
            {
                arguments = null;
            }
            if (arguments is null) return ToStream(json);

            bool isQueryTool = queryToolPrefixes.Any(p =>
                toolName.Equals(p, StringComparison.OrdinalIgnoreCase));
            bool isWriteTool = writeToolPrefixes.Any(p =>
                toolName.Equals(p, StringComparison.OrdinalIgnoreCase));

            if (!isQueryTool && !isWriteTool) return ToStream(json);

            // Write-Tools: ownerid im Payload forcieren (innerhalb von "item")
            // Außerdem: read-only Systemfelder entfernen, die der Agent fälschlicherweise setzt.
            if (isWriteTool && Guid.TryParse(userCtx.UserId, out _))
            {
                var itemNode = arguments["item"] as JsonObject;
                if (itemNode is not null)
                {
                    // Read-only Systemfelder entfernen – Dataverse MCP wirft sonst GetEntityReference-Fehler,
                    // wenn der Agent diese mit ungültigen Werten (z.B. "callerid") belegt.
                    string[] readOnlyFields = ["createdby", "modifiedby", "createdon", "modifiedon",
                        "owningbusinessunit", "owninguser", "owningteam"];
                    foreach (var field in readOnlyFields)
                        itemNode.Remove(field);

                    // ownerid als EntityReference-Objekt setzen (Dataverse MCP Plugin-Format):
                    // {"recordId":"guid","relatedTable":"systemuser"}
                    itemNode[ownerField] = new JsonObject
                    {
                        ["recordId"]     = JsonValue.Create(userCtx.UserId),
                        ["relatedTable"] = JsonValue.Create("systemuser")
                    };

                    if (argumentsWasString)
                        paramsObj!["arguments"] = JsonValue.Create(arguments.ToJsonString());

                    var writeJson = root.ToJsonString();
                    Console.WriteLine($"[FILTER-DIAG] ownerid EntityRef gesetzt in {toolName}: systemuser/{userCtx.UserId}");
                    return ToStream(writeJson);
                }
            }

            if (toolName.Equals("read_query", StringComparison.OrdinalIgnoreCase))
            {
                // Dataverse MCP verwendet "querytext" als Argument-Feldname (nicht "query")
                var sqlField = arguments.ContainsKey("querytext") ? "querytext" : "query";
                var sql = arguments[sqlField]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(sql)) return ToStream(json);

                arguments[sqlField] = JsonValue.Create(
                    InjectSqlWhereClause(sql, ownerField, extraUserFields, userCtx,
                        accountTable, contactTable, contactParentField));

                // Falls arguments ursprünglich ein JSON-String war, zurück als String serialisieren.
                if (argumentsWasString)
                    paramsObj!["arguments"] = JsonValue.Create(arguments.ToJsonString());

                var resultJson = root.ToJsonString();
                // Nur ersten 300 Zeichen loggen um Token-Leaks zu vermeiden
                var preview = resultJson.Length > 300 ? resultJson[..300] + "..." : resultJson;
                Console.WriteLine($"[FILTER-DIAG] SQL nach Filter-Injektion: {preview}");
                return ToStream(resultJson);
            }

            return ToStream(json);
        }
        catch
        {
            return ToStream(json);
        }
    }

    /// <summary>
    /// Baut die entity-spezifische WHERE-Bedingung und fügt sie in die SQL ein.
    ///
    /// account/andere → (ownerid IN ('userId','teamId1',...) OR createdby = 'userId' OR modifiedby = 'userId')
    /// contact        → (ownerid IN (...) OR parentcustomerid IN ('acct1',...) OR createdby = ... OR modifiedby = ...)
    ///
    /// Extra-Felder konfigurierbar via DATAVERSE_EXTRA_USER_FIELDS (Standard: createdby,modifiedby).
    /// Alle GUIDs werden validiert – ungültige werden stille ignoriert.
    /// Liefert den SQL unverändert zurück wenn nach Validierung keine gültigen IDs verbleiben.
    /// </summary>
    private static string InjectSqlWhereClause(
        string sql, string ownerField, string[] extraUserFields, UserContext userCtx,
        string accountTable, string contactTable, string contactParentField)
    {
        // Alle Owner-IDs (User + Teams) validieren
        var ownerIds = new[] { userCtx.UserId }
            .Concat(userCtx.TeamIds)
            .Where(id => Guid.TryParse(id, out _))
            .ToArray();

        if (ownerIds.Length == 0) return sql; // keine gültigen GUIDs – kein Filter

        // Validierte User-GUID (nur userId, keine Teams – für createdby/modifiedby)
        var validUserId = Guid.TryParse(userCtx.UserId, out _) ? userCtx.UserId : null;

        // Tabellenname aus FROM-Klausel ermitteln
        var tableName = ExtractFromTable(sql);

        string filterClause;
        if (string.Equals(tableName, contactTable, StringComparison.OrdinalIgnoreCase))
        {
            // Kontakte: ownerid IN (...) OR parentcustomerid IN (owned accounts)
            var ownerIn = BuildInClause(ownerField, ownerIds);
            var validAccountIds = userCtx.AccountIds
                .Where(id => Guid.TryParse(id, out _))
                .ToArray();

            var contactBase = validAccountIds.Length > 0
                ? $"{ownerIn} OR {BuildInClause(contactParentField, validAccountIds)}"
                : ownerIn;

            // Extra-Felder (createdby, modifiedby) ebenfalls OR-verknüpfen
            var extraParts = validUserId is not null
                ? extraUserFields.Select(f => $"{f} = '{validUserId}'")
                : [];
            var allParts = new[] { contactBase }.Concat(extraParts);
            filterClause = $"({string.Join(" OR ", allParts)})";
        }
        else
        {
            // account, KoRa Protokolle und alle anderen:
            // (ownerid IN (userId, teamIds) OR createdby = userId OR modifiedby = userId)
            var ownerIn = BuildInClause(ownerField, ownerIds);
            var extraParts = validUserId is not null
                ? extraUserFields.Select(f => $"{f} = '{validUserId}'")
                : [];
            var allParts = new[] { ownerIn }.Concat(extraParts).ToArray();
            filterClause = allParts.Length == 1
                ? allParts[0]
                : $"({string.Join(" OR ", allParts)})";
        }

        return InsertWhereClause(sql, filterClause);
    }

    /// <summary>Extrahiert den ersten Tabellennamen nach FROM.</summary>
    private static string? ExtractFromTable(string sql)
    {
        var upperSql = sql.ToUpperInvariant();
        var fromIdx = IndexOfKeyword(upperSql, "FROM");
        if (fromIdx < 0) return null;

        var afterFrom = sql[(fromIdx + 4)..].TrimStart().TrimStart('[');
        var m = System.Text.RegularExpressions.Regex.Match(afterFrom, @"^(\w+)");
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>Baut "field IN ('id1','id2',...)".</summary>
    private static string BuildInClause(string field, string[] ids)
        => ids.Length == 1
            ? $"{field} = '{ids[0]}'"
            : $"{field} IN ({string.Join(", ", ids.Select(id => $"'{id}'"))})";

    /// <summary>Findet den Index eines SQL-Schlüsselworts als eigenständiges Token.</summary>
    private static int IndexOfKeyword(string upperSql, string keyword)
    {
        int idx = 0;
        while (idx < upperSql.Length)
        {
            int found = upperSql.IndexOf(keyword, idx, StringComparison.Ordinal);
            if (found < 0) return -1;
            bool prevOk  = found == 0 || char.IsWhiteSpace(upperSql[found - 1]);
            bool nextOk  = found + keyword.Length >= upperSql.Length
                           || char.IsWhiteSpace(upperSql[found + keyword.Length]);
            if (prevOk && nextOk) return found;
            idx = found + 1;
        }
        return -1;
    }

    /// <summary>Fügt filterClause als WHERE / AND in den SQL-String ein.</summary>
    private static string InsertWhereClause(string sql, string filterClause)
    {
        var upperSql = sql.ToUpperInvariant();
        string[] terminators = ["ORDER BY", "GROUP BY", "HAVING"];

        int whereIdx = IndexOfKeyword(upperSql, "WHERE");
        if (whereIdx >= 0)
        {
            int insertAt = sql.Length;
            foreach (var term in terminators)
            {
                int ti = IndexOfKeyword(upperSql, term);
                if (ti > whereIdx && ti < insertAt) insertAt = ti;
            }
            return sql[..insertAt].TrimEnd() + $" AND {filterClause}" + sql[insertAt..];
        }
        else
        {
            int insertAt = sql.Length;
            foreach (var term in terminators)
            {
                int ti = IndexOfKeyword(upperSql, term);
                if (ti >= 0 && ti < insertAt) insertAt = ti;
            }
            return sql[..insertAt].TrimEnd() + $" WHERE {filterClause} " + sql[insertAt..].TrimStart();
        }
    }

    private static Stream ToStream(string s)
        => new MemoryStream(Encoding.UTF8.GetBytes(s));

    /// <summary>Liest einen einzelnen Query-Parameter (URL-decoded) aus dem Query-String.</summary>
    private static string? ExtractQueryParam(string query, string paramName)
    {
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var sep = part.IndexOf('=');
            var key = Uri.UnescapeDataString(sep >= 0 ? part[..sep] : part);
            if (string.Equals(key, paramName, StringComparison.OrdinalIgnoreCase))
                return sep >= 0 ? Uri.UnescapeDataString(part[(sep + 1)..]) : string.Empty;
        }
        return null;
    }

    private static class HttpMethods
    {
        public static bool IsGet(string method) => string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase);
        public static bool IsHead(string method) => string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
        public static bool IsOptions(string method) => string.Equals(method, "OPTIONS", StringComparison.OrdinalIgnoreCase);
    }
}