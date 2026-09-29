namespace KPolls.Api.Configuration;

/// <summary>
/// Bound from configuration and environment variables. Names match the .env
/// keys used by the Node server so one environment file drives either backend.
/// </summary>
public sealed class PollOptions
{
    public const string SectionName = "Poll";

    public string DatabaseUrl { get; set; } = string.Empty;

    /// <summary>Salt for every hash that reaches the database.</summary>
    public string DeviceSalt { get; set; } = string.Empty;

    /// <summary>HMAC key for voter tokens.</summary>
    public string SessionSecret { get; set; } = string.Empty;

    public double TokenTtlHours { get; set; } = 24 * 365;

    public string AllowedCountryCode { get; set; } = "KE";

    /// <summary>lenient (default) | strict | off. See RequestSignals.</summary>
    public string GeoEnforcement { get; set; } = "lenient";

    public string AllowedOrigins { get; set; } = string.Empty;

    public bool TrustProxy { get; set; } = true;

    public int VotePerIpPerMinute { get; set; } = 10;

    public int VotePerIpPerHour { get; set; } = 60;

    public int MaxVotesPerFingerprint { get; set; } = 25;

    /// <summary>
    /// How long a tally may be served from memory. Small values keep the page
    /// lively; anything above zero collapses a burst of readers into one query.
    /// </summary>
    public int ResultsCacheSeconds { get; set; } = 2;

    /// <summary>Upper bound on the Npgsql pool.</summary>
    public int MaxPoolSize { get; set; } = 80;

    public string[] OriginList() => AllowedOrigins
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(DatabaseUrl))
        {
            throw new InvalidOperationException("DATABASE_URL is required.");
        }

        if (DeviceSalt.Length < 32)
        {
            throw new InvalidOperationException("DEVICE_SALT must be at least 32 characters.");
        }

        if (SessionSecret.Length < 32)
        {
            throw new InvalidOperationException("SESSION_SECRET must be at least 32 characters.");
        }

        if (AllowedCountryCode.Length != 2)
        {
            throw new InvalidOperationException("ALLOWED_COUNTRY_CODE must be a 2-letter code.");
        }
    }
}
