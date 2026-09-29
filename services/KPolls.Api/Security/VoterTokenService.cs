using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using KPolls.Api.Configuration;
using KPolls.Api.Models;
using Microsoft.Extensions.Options;

namespace KPolls.Api.Security;

/// <summary>
/// Mints and verifies voter tokens.
///
/// Format: base64url(UTF-8 JSON payload) "." base64url(HMAC-SHA256 of that
/// body). Identical to src/token.js and supabase/functions/_shared/utils.ts, so
/// a deployment can switch backends without invalidating anyone's vote receipt.
///
/// The token is the identity the unique index in Postgres keys on. A browser can
/// read it but cannot forge one, and only GET /api/poll mints them - POST
/// /api/vote never does, so discarding a token loses the receipt without
/// creating a second voter.
/// </summary>
public sealed class VoterTokenService
{
    private readonly byte[] _tokenSecret;
    private readonly byte[] _deviceSalt;
    private readonly TimeSpan _ttl;

    public const string HeaderName = "x-voter-token";

    public VoterTokenService(IOptions<PollOptions> options)
    {
        var settings = options.Value;
        _tokenSecret = Encoding.UTF8.GetBytes(settings.SessionSecret);
        _deviceSalt = Encoding.UTF8.GetBytes(settings.DeviceSalt);
        _ttl = TimeSpan.FromHours(settings.TokenTtlHours);
    }

    /// <summary>Mints a brand new identity for this poll.</summary>
    public VoterTokenPayload CreatePayload(int pollId, string browserSignature)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        return new VoterTokenPayload
        {
            Version = 1,
            PollId = pollId,
            DeviceId = NewDeviceId(),
            Signature = browserSignature,
            IssuedAt = now,
            ExpiresAt = now + (long)_ttl.TotalSeconds,
        };
    }

    public string Encode(VoterTokenPayload payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, AppJsonContext.Default.VoterTokenPayload);
        var body = ToBase64Url(json);
        var signature = ToBase64Url(HmacSha256(_tokenSecret, Encoding.UTF8.GetBytes(body)));
        return string.Concat(body, ".", signature);
    }

    /// <summary>
    /// Returns null for anything that is not a currently valid token. Signature
    /// comparison is fixed-time.
    /// </summary>
    public VoterTokenPayload? Verify(string? token)
    {
        if (string.IsNullOrEmpty(token))
        {
            return null;
        }

        var separator = token.IndexOf('.');
        if (separator <= 0 || separator == token.Length - 1)
        {
            return null;
        }

        // Reject a second separator rather than silently ignoring the tail.
        if (token.IndexOf('.', separator + 1) >= 0)
        {
            return null;
        }

        var body = token.AsSpan(0, separator);
        var signature = token[(separator + 1)..];

        var expected = ToBase64Url(HmacSha256(_tokenSecret, Encoding.UTF8.GetBytes(body.ToString())));

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(signature),
                Encoding.UTF8.GetBytes(expected)))
        {
            return null;
        }

        VoterTokenPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize(
                FromBase64Url(body.ToString()),
                AppJsonContext.Default.VoterTokenPayload);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (FormatException)
        {
            return null;
        }

        if (payload is null ||
            payload.Version != 1 ||
            payload.PollId <= 0 ||
            string.IsNullOrEmpty(payload.DeviceId) ||
            payload.DeviceId.Length < 16)
        {
            return null;
        }

        return payload.ExpiresAt < DateTimeOffset.UtcNow.ToUnixTimeSeconds() ? null : payload;
    }

    /// <summary>Salted hash of the device id - this is what reaches the database.</summary>
    public string DeviceHash(VoterTokenPayload payload) =>
        HmacHex(_deviceSalt, $"device:{payload.PollId}:{payload.DeviceId}");

    public string HashWithSalt(string value) => HmacHex(_deviceSalt, value);

    private static string NewDeviceId()
    {
        Span<byte> bytes = stackalloc byte[24];
        RandomNumberGenerator.Fill(bytes);
        return ToBase64Url(bytes);
    }

    private static byte[] HmacSha256(byte[] key, byte[] data) => HMACSHA256.HashData(key, data);

    public static string HmacHex(byte[] key, string input) =>
        Convert.ToHexString(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(input))).ToLowerInvariant();

    private static string ToBase64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromBase64Url(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight((padded.Length + 3) / 4 * 4, '='));
    }
}
