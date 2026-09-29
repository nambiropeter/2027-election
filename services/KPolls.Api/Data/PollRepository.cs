using KPolls.Api.Models;
using Npgsql;
using NpgsqlTypes;

namespace KPolls.Api.Data;

public enum CastVoteStatus
{
    Ok,
    AlreadyVoted,
    PollClosed,
    InvalidOption,
    FingerprintLimit,
    Unknown,
}

public sealed record CastVoteResult(CastVoteStatus Status, int? OptionId);

public sealed record ActivePoll(int Id, string Question);

/// <summary>
/// Every statement here calls a SECURITY DEFINER function from
/// supabase/migrations - the same entry points the Node server and the edge
/// functions use - so the integrity rules live in one place regardless of which
/// backend is serving.
/// </summary>
public sealed class PollRepository(NpgsqlDataSource dataSource, ILogger<PollRepository> logger)
{
    public async Task<ActivePoll?> GetActivePollAsync(CancellationToken cancellationToken)
    {
        const string sql =
            "SELECT id, question FROM polls WHERE is_active = TRUE ORDER BY id DESC LIMIT 1";

        await using var command = dataSource.CreateCommand(sql);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new ActivePoll(reader.GetInt32(0), reader.GetString(1));
    }

    public async Task<PollSnapshot?> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        var poll = await GetActivePollAsync(cancellationToken);
        if (poll is null)
        {
            return null;
        }

        var options = await GetResultsAsync(poll.Id, cancellationToken);
        var total = options.Sum(option => option.Votes);

        return new PollSnapshot(poll.Id, poll.Question, total, options);
    }

    public async Task<IReadOnlyList<OptionResult>> GetResultsAsync(
        int pollId,
        CancellationToken cancellationToken)
    {
        const string sql = "SELECT id, label, votes FROM poll_results($1)";

        await using var command = dataSource.CreateCommand(sql);
        command.Parameters.Add(new NpgsqlParameter { Value = pollId, NpgsqlDbType = NpgsqlDbType.Integer });

        var results = new List<OptionResult>(8);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            results.Add(new OptionResult(reader.GetInt32(0), reader.GetString(1), reader.GetInt32(2)));
        }

        return results;
    }

    public async Task<int?> GetVotedOptionAsync(
        int pollId,
        string deviceHash,
        CancellationToken cancellationToken)
    {
        const string sql = "SELECT has_voted($1, $2)";

        await using var command = dataSource.CreateCommand(sql);
        command.Parameters.Add(new NpgsqlParameter { Value = pollId, NpgsqlDbType = NpgsqlDbType.Integer });
        command.Parameters.Add(new NpgsqlParameter { Value = deviceHash, NpgsqlDbType = NpgsqlDbType.Char });

        var value = await command.ExecuteScalarAsync(cancellationToken);
        return value is null or DBNull ? null : Convert.ToInt32(value);
    }

    /// <summary>
    /// Durable rate limit backing the in-process limiter. The in-process one
    /// absorbs the load; this one survives restarts and spans replicas.
    /// </summary>
    public async Task<bool> ConsumeRateLimitAsync(
        string key,
        int limit,
        int windowSeconds,
        CancellationToken cancellationToken)
    {
        const string sql = "SELECT consume_rate_limit($1, $2, $3)";

        try
        {
            await using var command = dataSource.CreateCommand(sql);
            command.Parameters.Add(new NpgsqlParameter { Value = key, NpgsqlDbType = NpgsqlDbType.Text });
            command.Parameters.Add(new NpgsqlParameter { Value = limit, NpgsqlDbType = NpgsqlDbType.Integer });
            command.Parameters.Add(new NpgsqlParameter { Value = windowSeconds, NpgsqlDbType = NpgsqlDbType.Integer });

            var value = await command.ExecuteScalarAsync(cancellationToken);
            return value is not bool allowed || allowed;
        }
        catch (NpgsqlException exception)
        {
            // Fail open: the in-process limiter has already run, and a database
            // hiccup should not take voting down entirely.
            logger.LogWarning(exception, "Durable rate limit check failed for {Key}", key);
            return true;
        }
    }

    /// <summary>
    /// Casts a vote. All integrity checks and the insert happen inside one
    /// database call, so two concurrent requests for the same device cannot both
    /// pass the checks.
    /// </summary>
    public async Task<CastVoteResult> CastVoteAsync(
        int pollId,
        int optionId,
        string deviceHash,
        string ipHash,
        string fingerprintHash,
        string userAgentHash,
        string countryCode,
        int maxPerFingerprint,
        CancellationToken cancellationToken)
    {
        const string sql =
            "SELECT status, option_id FROM cast_vote($1, $2, $3, $4, $5, $6, $7, $8)";

        await using var command = dataSource.CreateCommand(sql);
        command.Parameters.Add(new NpgsqlParameter { Value = pollId, NpgsqlDbType = NpgsqlDbType.Integer });
        command.Parameters.Add(new NpgsqlParameter { Value = optionId, NpgsqlDbType = NpgsqlDbType.Integer });
        command.Parameters.Add(new NpgsqlParameter { Value = deviceHash, NpgsqlDbType = NpgsqlDbType.Char });
        command.Parameters.Add(new NpgsqlParameter { Value = ipHash, NpgsqlDbType = NpgsqlDbType.Char });
        command.Parameters.Add(new NpgsqlParameter { Value = fingerprintHash, NpgsqlDbType = NpgsqlDbType.Char });
        command.Parameters.Add(new NpgsqlParameter { Value = userAgentHash, NpgsqlDbType = NpgsqlDbType.Char });
        command.Parameters.Add(new NpgsqlParameter { Value = countryCode, NpgsqlDbType = NpgsqlDbType.Char });
        command.Parameters.Add(new NpgsqlParameter { Value = maxPerFingerprint, NpgsqlDbType = NpgsqlDbType.Integer });

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        if (!await reader.ReadAsync(cancellationToken))
        {
            return new CastVoteResult(CastVoteStatus.Unknown, null);
        }

        var status = reader.IsDBNull(0) ? "unknown" : reader.GetString(0);
        int? recordedOption = reader.IsDBNull(1) ? null : reader.GetInt32(1);

        return new CastVoteResult(Parse(status), recordedOption);
    }

    private static CastVoteStatus Parse(string status) => status switch
    {
        "ok" => CastVoteStatus.Ok,
        "already_voted" => CastVoteStatus.AlreadyVoted,
        "poll_closed" => CastVoteStatus.PollClosed,
        "invalid_option" => CastVoteStatus.InvalidOption,
        "fingerprint_limit" => CastVoteStatus.FingerprintLimit,
        _ => CastVoteStatus.Unknown,
    };
}
