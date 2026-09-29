using System.Globalization;
using System.IO.Compression;
using System.Threading.RateLimiting;
using KPolls.Api.Configuration;
using KPolls.Api.Data;
using KPolls.Api.Models;
using KPolls.Api.Security;
using KPolls.Api.Services;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Options;
using Npgsql;

var builder = WebApplication.CreateSlimBuilder(args);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The .env keys the Node server already uses map straight onto PollOptions, so
// one environment file drives either backend.
builder.Configuration.AddInMemoryCollection(EnvironmentMap.Build());
builder.Services.Configure<PollOptions>(builder.Configuration.GetSection(PollOptions.SectionName));

var pollOptions = builder.Configuration.GetSection(PollOptions.SectionName).Get<PollOptions>()
                  ?? new PollOptions();
pollOptions.Validate();

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJsonContext.Default);
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

builder.Services.AddNpgsqlDataSource(
    ConnectionString.FromUrl(pollOptions.DatabaseUrl, pollOptions.MaxPoolSize));

builder.Services.AddSingleton<VoterTokenService>();
builder.Services.AddSingleton<RequestSignals>();
builder.Services.AddSingleton<PollRepository>();
builder.Services.AddSingleton<ResultsCache>();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // Behind our own reverse proxy (Caddy) or a managed load balancer.
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        var origins = pollOptions.OriginList();
        if (origins.Length > 0)
        {
            policy.WithOrigins(origins).AllowCredentials();
        }
        else
        {
            policy.AllowAnyOrigin();
        }

        policy.WithMethods("GET", "POST", "OPTIONS")
              .WithHeaders("content-type", VoterTokenService.HeaderName)
              .WithExposedHeaders(VoterTokenService.HeaderName);
    });
});

builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

// First line of defence: an in-process limiter that rejects a flood without
// touching the database at all. PollRepository.ConsumeRateLimitAsync is the
// durable second line that spans replicas and restarts.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy("vote", context => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: ClientKey(context),
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = pollOptions.VotePerIpPerMinute,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.AddPolicy("read", context => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: ClientKey(context),
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 240,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.OnRejected = async (context, token) =>
    {
        context.HttpContext.Response.ContentType = "application/json";
        await context.HttpContext.Response.WriteAsJsonAsync(
            new ErrorResponse("Too many requests. Please slow down.", "rate_limited"),
            AppJsonContext.Default.ErrorResponse,
            cancellationToken: token);
    };
});

var app = builder.Build();

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

app.UseForwardedHeaders();
app.UseResponseCompression();

app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "DENY";
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    headers["Content-Security-Policy"] =
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
        "script-src 'self' https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net " +
        "https://tpc.googlesyndication.com; style-src 'self'; img-src 'self' data: https:; " +
        "connect-src 'self' https://*.supabase.co; " +
        "frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com";

    await next();
});

app.UseCors();
app.UseRateLimiter();

// Serve the same static site as the Node server when the files are present.
// STATIC_ROOT overrides the default, which resolves to <repo>/public both when
// running from the project directory and from the container layout.
var webRoot = Environment.GetEnvironmentVariable("STATIC_ROOT") is { Length: > 0 } configuredRoot
    ? Path.GetFullPath(configuredRoot)
    : Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "..", "public"));
if (Directory.Exists(webRoot))
{
    var fileOptions = new FileServerOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(webRoot),
        EnableDefaultFiles = true,
        EnableDirectoryBrowsing = false,
    };
    fileOptions.StaticFileOptions.OnPrepareResponse = ctx =>
        ctx.Context.Response.Headers.CacheControl = "public, max-age=300";

    app.UseFileServer(fileOptions);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

app.MapGet("/health", () => Results.Json(new HealthResponse("ok"), AppJsonContext.Default.HealthResponse));

app.MapGet("/api/poll", async (
    HttpContext context,
    ResultsCache cache,
    PollRepository repository,
    VoterTokenService tokens,
    RequestSignals signals,
    CancellationToken cancellationToken) =>
{
    var snapshot = await cache.GetAsync(cancellationToken);
    if (snapshot is null)
    {
        return Results.Json(
            new ErrorResponse("No active poll configured."),
            AppJsonContext.Default.ErrorResponse,
            statusCode: StatusCodes.Status404NotFound);
    }

    // Reuse the caller's token when it is valid for this poll; only this
    // endpoint mints identities.
    var presented = tokens.Verify(ReadToken(context));
    var payload = presented is not null && presented.PollId == snapshot.PollId
        ? presented
        : tokens.CreatePayload(snapshot.PollId, signals.BrowserSignature(context));

    var token = tokens.Encode(payload);

    var votedOptionId = await repository.GetVotedOptionAsync(
        snapshot.PollId, tokens.DeviceHash(payload), cancellationToken);

    var geo = signals.CheckCountry(context);

    context.Response.Headers[VoterTokenService.HeaderName] = token;
    context.Response.Headers.CacheControl = "no-store";

    return Results.Json(
        new PollResponse(
            snapshot.PollId,
            snapshot.Question,
            snapshot.TotalVotes,
            snapshot.Options,
            votedOptionId is not null,
            votedOptionId,
            geo.CountryCode,
            geo.Allowed,
            token),
        AppJsonContext.Default.PollResponse);
})
.RequireRateLimiting("read");

app.MapGet("/api/results", async (
    HttpContext context,
    ResultsCache cache,
    CancellationToken cancellationToken) =>
{
    var snapshot = await cache.GetAsync(cancellationToken);
    if (snapshot is null)
    {
        return Results.Json(
            new ErrorResponse("No active poll configured."),
            AppJsonContext.Default.ErrorResponse,
            statusCode: StatusCodes.Status404NotFound);
    }

    context.Response.Headers.CacheControl = "no-store";

    return Results.Json(
        new ResultsResponse(snapshot.PollId, snapshot.TotalVotes, snapshot.Options),
        AppJsonContext.Default.ResultsResponse);
})
.RequireRateLimiting("read");

app.MapPost("/api/vote", async (
    HttpContext context,
    VoteRequest? body,
    ResultsCache cache,
    PollRepository repository,
    VoterTokenService tokens,
    RequestSignals signals,
    IOptions<PollOptions> settings,
    CancellationToken cancellationToken) =>
{
    var options = settings.Value;

    var poll = await repository.GetActivePollAsync(cancellationToken);
    if (poll is null)
    {
        return Error("No active poll configured.", null, StatusCodes.Status404NotFound);
    }

    var payload = tokens.Verify(ReadToken(context) ?? body?.Token);
    if (payload is null || payload.PollId != poll.Id)
    {
        return Error(
            "Your voting session is missing or expired. Reload the page and try again.",
            "invalid_token",
            StatusCodes.Status401Unauthorized);
    }

    var optionId = body?.OptionId ?? 0;
    if (optionId <= 0)
    {
        return Error("Choose a valid option.", "invalid_option", StatusCodes.Status400BadRequest);
    }

    var ip = signals.ClientIp(context);
    var ipHash = tokens.HashWithSalt($"ip:{ip}");
    var networkHash = tokens.HashWithSalt($"net:{RequestSignals.Network(ip)}");
    var signature = signals.BrowserSignature(context);

    var withinHour = await repository.ConsumeRateLimitAsync(
        $"vote:hr:{ipHash}", options.VotePerIpPerHour, 3600, cancellationToken);

    if (!withinHour)
    {
        return Error(
            "Too many attempts from your connection. Try again later.",
            "rate_limited",
            StatusCodes.Status429TooManyRequests);
    }

    var geo = signals.CheckCountry(context);
    if (!geo.Allowed)
    {
        return Error(
            $"Voting is open to {options.AllowedCountryCode} connections only.",
            "geo_blocked",
            StatusCodes.Status403Forbidden);
    }

    var result = await repository.CastVoteAsync(
        poll.Id,
        optionId,
        tokens.DeviceHash(payload),
        ipHash,
        tokens.HashWithSalt($"fp:{payload.PollId}:{networkHash}:{signature}"),
        signature,
        geo.CountryCode,
        options.MaxVotesPerFingerprint,
        cancellationToken);

    if (result.Status != CastVoteStatus.Ok)
    {
        var (message, code, status) = result.Status switch
        {
            CastVoteStatus.AlreadyVoted =>
                ("You have already voted in this poll.", "already_voted", StatusCodes.Status409Conflict),
            CastVoteStatus.PollClosed =>
                ("This poll is closed.", "poll_closed", StatusCodes.Status410Gone),
            CastVoteStatus.InvalidOption =>
                ("Choose a valid option.", "invalid_option", StatusCodes.Status400BadRequest),
            CastVoteStatus.FingerprintLimit =>
                ("Unusual activity from your connection. Try again later.", "fingerprint_limit",
                    StatusCodes.Status429TooManyRequests),
            _ => ("Could not record your vote. Try again.", "error",
                    StatusCodes.Status500InternalServerError),
        };

        return Results.Json(
            new ErrorResponse(message, code, result.OptionId),
            AppJsonContext.Default.ErrorResponse,
            statusCode: status);
    }

    // The voter must see their own vote, so refresh rather than serve the
    // snapshot this request started from.
    cache.Invalidate();
    var snapshot = await cache.GetAsync(cancellationToken);
    var freshOptions = snapshot?.Options ?? [];

    return Results.Json(
        new VoteAccepted(
            "Vote recorded.",
            optionId,
            geo.CountryCode,
            snapshot?.TotalVotes ?? 0,
            freshOptions),
        AppJsonContext.Default.VoteAccepted,
        statusCode: StatusCodes.Status201Created);
})
.RequireRateLimiting("vote");

// Deep links fall back to the single page rather than 404.
app.MapFallback(async context =>
{
    var indexPath = Path.Combine(webRoot, "index.html");
    if (context.Request.Method == HttpMethods.Get &&
        !context.Request.Path.StartsWithSegments("/api") &&
        File.Exists(indexPath))
    {
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.SendFileAsync(indexPath);
        return;
    }

    context.Response.StatusCode = StatusCodes.Status404NotFound;
    await context.Response.WriteAsJsonAsync(
        new ErrorResponse("Not found."), AppJsonContext.Default.ErrorResponse);
});

app.Run();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static string? ReadToken(HttpContext context)
{
    var header = context.Request.Headers[VoterTokenService.HeaderName].ToString();
    if (!string.IsNullOrEmpty(header))
    {
        return header;
    }

    return context.Request.Cookies.TryGetValue("poll_session", out var cookie) && !string.IsNullOrEmpty(cookie)
        ? cookie
        : null;
}

static IResult Error(string message, string? code, int status) =>
    Results.Json(
        new ErrorResponse(message, code),
        AppJsonContext.Default.ErrorResponse,
        statusCode: status);

static string ClientKey(HttpContext context)
{
    var forwarded = context.Request.Headers["X-Forwarded-For"].ToString();
    if (!string.IsNullOrEmpty(forwarded))
    {
        var first = forwarded.Split(',', StringSplitOptions.TrimEntries).FirstOrDefault();
        if (!string.IsNullOrEmpty(first))
        {
            return first;
        }
    }

    return context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}

/// <summary>Maps the project's existing .env keys onto PollOptions.</summary>
internal static class EnvironmentMap
{
    private static readonly (string Env, string Key)[] Mappings =
    [
        ("DATABASE_URL", "Poll:DatabaseUrl"),
        ("DEVICE_SALT", "Poll:DeviceSalt"),
        ("SESSION_SECRET", "Poll:SessionSecret"),
        ("TOKEN_TTL_HOURS", "Poll:TokenTtlHours"),
        ("ALLOWED_COUNTRY_CODE", "Poll:AllowedCountryCode"),
        ("GEO_ENFORCEMENT", "Poll:GeoEnforcement"),
        ("ALLOWED_ORIGINS", "Poll:AllowedOrigins"),
        ("TRUST_PROXY", "Poll:TrustProxy"),
        ("VOTE_PER_IP_PER_MINUTE", "Poll:VotePerIpPerMinute"),
        ("VOTE_PER_IP_PER_HOUR", "Poll:VotePerIpPerHour"),
        ("MAX_VOTES_PER_FINGERPRINT", "Poll:MaxVotesPerFingerprint"),
        ("RESULTS_CACHE_SECONDS", "Poll:ResultsCacheSeconds"),
        ("DB_MAX_POOL_SIZE", "Poll:MaxPoolSize"),
    ];

    public static Dictionary<string, string?> Build()
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        foreach (var (env, key) in Mappings)
        {
            var value = Environment.GetEnvironmentVariable(env);
            if (!string.IsNullOrWhiteSpace(value))
            {
                // TRUST_PROXY accepts the shell-style truthy values the Node
                // config already honours.
                values[key] = key.EndsWith("TrustProxy", StringComparison.Ordinal)
                    ? Truthy(value).ToString(CultureInfo.InvariantCulture)
                    : value;
            }
        }

        return values;
    }

    private static bool Truthy(string value) =>
        value.Trim().ToLowerInvariant() is "1" or "true" or "yes" or "on";
}

/// <summary>Converts a postgres:// URL into an Npgsql connection string.</summary>
internal static class ConnectionString
{
    public static string FromUrl(string value, int maxPoolSize)
    {
        if (!value.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase) &&
            !value.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase))
        {
            // Already a key/value connection string.
            return value;
        }

        var uri = new Uri(value);
        var userInfo = uri.UserInfo.Split(':', 2);

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = uri.AbsolutePath.Trim('/'),
            Username = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : null,
            MaxPoolSize = maxPoolSize,
            Pooling = true,
            // Managed Postgres (Supabase, RDS) terminates plaintext connections.
            SslMode = SslMode.Prefer,
        };

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length != 2)
            {
                continue;
            }

            if (parts[0].Equals("sslmode", StringComparison.OrdinalIgnoreCase) &&
                Enum.TryParse<SslMode>(Uri.UnescapeDataString(parts[1]), ignoreCase: true, out var parsed))
            {
                builder.SslMode = parsed;
            }
        }

        return builder.ConnectionString;
    }
}
