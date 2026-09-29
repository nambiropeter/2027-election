using System.Diagnostics;
using KPolls.Api.Configuration;
using KPolls.Api.Data;
using KPolls.Api.Models;
using Microsoft.Extensions.Options;

namespace KPolls.Api.Services;

/// <summary>
/// Serves the tally from memory for a short window.
///
/// The read path is overwhelmingly hotter than the write path: everyone loads
/// results, a few people vote. Without this, every page load and every 20-second
/// auto-refresh becomes a database round trip. With a two-second window, a burst
/// of readers collapses into a single query, and the single-flight guard means a
/// cold cache under load still issues exactly one query rather than one per
/// waiting request.
/// </summary>
public sealed class ResultsCache(
    PollRepository repository,
    IOptions<PollOptions> options,
    ILogger<ResultsCache> logger)
{
    private readonly TimeSpan _ttl = TimeSpan.FromSeconds(options.Value.ResultsCacheSeconds);
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private PollSnapshot? _snapshot;
    private long _refreshedAtTicks;

    private bool IsFresh =>
        _snapshot is not null &&
        Stopwatch.GetElapsedTime(Volatile.Read(ref _refreshedAtTicks)) < _ttl;

    public async Task<PollSnapshot?> GetAsync(CancellationToken cancellationToken)
    {
        if (IsFresh)
        {
            return _snapshot;
        }

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            // Another caller may have refreshed while this one waited.
            if (IsFresh)
            {
                return _snapshot;
            }

            var fresh = await repository.GetSnapshotAsync(cancellationToken);
            if (fresh is not null)
            {
                Store(fresh);
            }

            return fresh ?? _snapshot;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Stale results beat an error page while the database recovers.
            logger.LogError(exception, "Failed to refresh poll results");
            return _snapshot;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>Publishes totals a vote just produced, so the voter sees their own vote.</summary>
    public void Store(PollSnapshot snapshot)
    {
        _snapshot = snapshot;
        Volatile.Write(ref _refreshedAtTicks, Stopwatch.GetTimestamp());
    }

    public void Invalidate() => Volatile.Write(ref _refreshedAtTicks, 0);
}
