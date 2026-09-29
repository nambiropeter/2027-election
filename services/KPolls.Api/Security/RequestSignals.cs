using System.Net;
using KPolls.Api.Configuration;
using Microsoft.Extensions.Options;

namespace KPolls.Api.Security;

public sealed record GeoDecision(bool Allowed, string CountryCode, string Reason);

/// <summary>
/// Derives the request signals used for rate limiting, geo gating and the soft
/// fan-out throttle.
/// </summary>
public sealed class RequestSignals(IOptions<PollOptions> options, VoterTokenService tokens)
{
    private readonly PollOptions _options = options.Value;

    public string ClientIp(HttpContext context)
    {
        if (_options.TrustProxy &&
            context.Request.Headers.TryGetValue("X-Forwarded-For", out var forwarded))
        {
            var first = forwarded.ToString().Split(',', StringSplitOptions.TrimEntries).FirstOrDefault();
            if (!string.IsNullOrEmpty(first))
            {
                return Normalize(first);
            }
        }

        var remote = context.Connection.RemoteIpAddress;
        return remote is null ? "unknown" : Normalize(remote.ToString());
    }

    private static string Normalize(string ip)
    {
        if (IPAddress.TryParse(ip, out var parsed) && parsed.IsIPv4MappedToIPv6)
        {
            return parsed.MapToIPv4().ToString();
        }

        return ip;
    }

    /// <summary>
    /// Collapses an address to its network block (/24 for IPv4, /64 for IPv6) so
    /// the fan-out throttle sees a network rather than a single rotating address.
    /// </summary>
    public static string Network(string ip)
    {
        if (string.IsNullOrEmpty(ip) || ip == "unknown")
        {
            return "unknown";
        }

        if (ip.Contains(':'))
        {
            var groups = ip.Split(':');
            return string.Join(':', groups.Take(4)) + "::/64";
        }

        var octets = ip.Split('.');
        return octets.Length == 4 ? $"{octets[0]}.{octets[1]}.{octets[2]}.0/24" : ip;
    }

    /// <summary>
    /// Stable parts of the browser signature. Deliberately excludes the IP:
    /// Kenyan mobile users switch towers and networks constantly, and binding the
    /// token to an address would invalidate it mid-session.
    /// </summary>
    public string BrowserSignature(HttpContext context)
    {
        var userAgent = context.Request.Headers.UserAgent.ToString();
        var language = context.Request.Headers.AcceptLanguage.ToString();

        return tokens.HashWithSalt(
            $"ua:{(string.IsNullOrEmpty(userAgent) ? "unknown" : userAgent)}" +
            $"|lang:{(string.IsNullOrEmpty(language) ? "unknown" : language)}");
    }

    private string CountryFromHeaders(HttpContext context)
    {
        if (!_options.TrustProxy)
        {
            return string.Empty;
        }

        foreach (var header in (ReadOnlySpan<string>)["CF-IPCountry", "X-Vercel-IP-Country", "X-Country-Code"])
        {
            var value = context.Request.Headers[header].ToString().Trim().ToUpperInvariant();
            if (value.Length == 2 && value is not ("XX" or "T1") && value.All(char.IsAsciiLetterUpper))
            {
                return value;
            }
        }

        return string.Empty;
    }

    /// <summary>
    /// "lenient" (default) blocks only connections positively identified as
    /// foreign. "strict" also blocks unknown origins - correct only when every
    /// genuine request is guaranteed to carry a country header, otherwise it
    /// rejects real voters. "off" disables the check entirely.
    /// </summary>
    public GeoDecision CheckCountry(HttpContext context)
    {
        var country = CountryFromHeaders(context);
        if (string.IsNullOrEmpty(country))
        {
            country = "--";
        }

        var mode = _options.GeoEnforcement.ToLowerInvariant();

        if (mode == "off")
        {
            return new GeoDecision(true, country, "geo-check-disabled");
        }

        if (country == _options.AllowedCountryCode.ToUpperInvariant())
        {
            return new GeoDecision(true, country, "country-allowed");
        }

        if (country == "--")
        {
            var allowed = mode != "strict";
            return new GeoDecision(allowed, country, allowed ? "country-unknown-allowed" : "country-unknown-blocked");
        }

        return new GeoDecision(false, country, "country-blocked");
    }
}
