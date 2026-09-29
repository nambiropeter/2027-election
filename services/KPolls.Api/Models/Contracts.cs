using System.Text.Json.Serialization;

namespace KPolls.Api.Models;

/// <summary>
/// Wire contract shared with the Node server (src/server.js) and the Supabase
/// edge functions. The browser cannot tell which backend answered it, so these
/// names must not drift.
/// </summary>
public sealed record OptionResult(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("votes")] long Votes);

public sealed record PollSnapshot(
    [property: JsonPropertyName("pollId")] int PollId,
    [property: JsonPropertyName("question")] string Question,
    [property: JsonPropertyName("totalVotes")] long TotalVotes,
    [property: JsonPropertyName("options")] IReadOnlyList<OptionResult> Options);

public sealed record PollResponse(
    [property: JsonPropertyName("pollId")] int PollId,
    [property: JsonPropertyName("question")] string Question,
    [property: JsonPropertyName("totalVotes")] long TotalVotes,
    [property: JsonPropertyName("options")] IReadOnlyList<OptionResult> Options,
    [property: JsonPropertyName("hasVoted")] bool HasVoted,
    [property: JsonPropertyName("votedOptionId")] int? VotedOptionId,
    [property: JsonPropertyName("country")] string Country,
    [property: JsonPropertyName("countryAllowed")] bool CountryAllowed,
    [property: JsonPropertyName("token")] string Token);

public sealed record ResultsResponse(
    [property: JsonPropertyName("pollId")] int PollId,
    [property: JsonPropertyName("totalVotes")] long TotalVotes,
    [property: JsonPropertyName("options")] IReadOnlyList<OptionResult> Options);

public sealed record VoteRequest(
    [property: JsonPropertyName("optionId")] int OptionId,
    [property: JsonPropertyName("token")] string? Token);

public sealed record VoteAccepted(
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("votedOptionId")] int VotedOptionId,
    [property: JsonPropertyName("countryCode")] string CountryCode,
    [property: JsonPropertyName("totalVotes")] long TotalVotes,
    [property: JsonPropertyName("options")] IReadOnlyList<OptionResult> Options);

public sealed record ErrorResponse(
    [property: JsonPropertyName("error")] string Error,
    [property: JsonPropertyName("code")] string? Code = null,
    [property: JsonPropertyName("votedOptionId")] int? VotedOptionId = null);

public sealed record HealthResponse(
    [property: JsonPropertyName("status")] string Status);

/// <summary>
/// Payload carried inside the voter token. Property names are single letters so
/// the signed blob stays small, and must match the Node and Deno implementations
/// byte for byte.
/// </summary>
public sealed class VoterTokenPayload
{
    [JsonPropertyName("v")] public int Version { get; set; } = 1;
    [JsonPropertyName("p")] public int PollId { get; set; }
    [JsonPropertyName("d")] public string DeviceId { get; set; } = string.Empty;
    [JsonPropertyName("u")] public string Signature { get; set; } = string.Empty;
    [JsonPropertyName("iat")] public long IssuedAt { get; set; }
    [JsonPropertyName("exp")] public long ExpiresAt { get; set; }
}

/// <summary>
/// Compile-time JSON metadata. With reflection-based serialization disabled,
/// every payload type must be listed here.
/// </summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PollResponse))]
[JsonSerializable(typeof(ResultsResponse))]
[JsonSerializable(typeof(VoteRequest))]
[JsonSerializable(typeof(VoteAccepted))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(OptionResult))]
[JsonSerializable(typeof(VoterTokenPayload))]
public partial class AppJsonContext : JsonSerializerContext;
