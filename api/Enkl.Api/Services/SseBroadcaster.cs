using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Enkl.Api.Dtos;

namespace Enkl.Api.Services;

/// <summary>
/// In-process registry of open SSE connections (Controllers/EventsController.cs), keyed by userId —
/// a user can have several open connections at once (multiple browser tabs). Broadcasting writes a
/// pre-formatted SSE frame into every matching connection's channel; EventsController's stream loop
/// is the only reader of each channel, so writes here are fire-and-forget from the caller's
/// perspective (never blocks a mutating request on a slow/stalled client).
///
/// Single-instance only: this holds state in the api process's memory, so it only sees connections on
/// this replica. Fine for the current single-`api`-container docker-compose setup; scaling `api` to
/// more than one replica would need a shared backplane (Postgres LISTEN/NOTIFY is the natural fit
/// since Postgres is already the datastore) so a broadcast reaches connections held by other replicas.
/// </summary>
public class SseBroadcaster
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<SseConnection, byte>> _connectionsByUser = new();

    public SseConnection Register(Guid userId, string? clientSessionId)
    {
        var connection = new SseConnection(this, userId, clientSessionId);
        var set = _connectionsByUser.GetOrAdd(userId, _ => new ConcurrentDictionary<SseConnection, byte>());
        set[connection] = 0;
        return connection;
    }

    internal void Unregister(Guid userId, SseConnection connection)
    {
        if (_connectionsByUser.TryGetValue(userId, out var set))
        {
            set.TryRemove(connection, out _);
            if (set.IsEmpty)
            {
                _connectionsByUser.TryRemove(userId, out _);
            }
        }
        connection.Channel.Writer.TryComplete();
    }

    /// <summary>
    /// Notifies every open connection belonging to any of `memberUserIds`, except the one whose
    /// ClientSessionId matches `excludeClientSessionId` — the tab that made the change already knows
    /// (it just did it), so it's excluded; that user's OTHER tabs/browsers still get notified, which is
    /// the actual gap this feature closes.
    /// </summary>
    public void BroadcastTaskChanged(IEnumerable<Guid> memberUserIds, TaskChangedEventDto payload, string? excludeClientSessionId)
    {
        Broadcast("task-changed", memberUserIds, payload, excludeClientSessionId);
    }

    /// <summary>Notifies every channel member's open connections of a new/edited/deleted chat message
    /// — same per-explicit-member-list scoping and self-tab exclusion as BroadcastTaskChanged. The
    /// payload's MentionedUserIds carries which of those members (if any) were @-tagged; the frontend
    /// decides whether to surface an extra highlighted alert for itself rather than this needing a
    /// second broadcast/event type.</summary>
    public void BroadcastChatMessage(IEnumerable<Guid> channelMemberUserIds, ChatMessageEventDto payload, string? excludeClientSessionId)
    {
        Broadcast("chat-message", channelMemberUserIds, payload, excludeClientSessionId);
    }

    private void Broadcast<T>(string eventName, IEnumerable<Guid> memberUserIds, T payload, string? excludeClientSessionId)
    {
        var frame = "event: " + eventName + "\ndata: " + JsonSerializer.Serialize(payload, JsonOptions) + "\n\n";
        foreach (var userId in memberUserIds)
        {
            if (!_connectionsByUser.TryGetValue(userId, out var set)) continue;
            foreach (var connection in set.Keys)
            {
                if (excludeClientSessionId is not null && connection.ClientSessionId == excludeClientSessionId) continue;
                connection.Channel.Writer.TryWrite(frame);
            }
        }
    }

    /// <summary>Snapshot of every userId with at least one open SSE connection right now — the basis
    /// for the "green dot" presence indicator (GET /api/organisations/me/roster). Deliberately a
    /// point-in-time poll target, not a push-on-connect/disconnect event: fanning a presence-changed
    /// notification out to an entire org on every connect/disconnect is a materially different
    /// (broadcast-to-everyone) shape than every other broadcast here, which targets an explicit,
    /// already-known member list.</summary>
    public IReadOnlyCollection<Guid> GetOnlineUserIds() => _connectionsByUser.Keys.ToArray();
}

/// <summary>
/// One open SSE stream. Disposing (when EventsController's request ends) unregisters it from the
/// owning broadcaster and completes its channel so the stream loop's `await foreach` exits cleanly.
/// </summary>
public sealed class SseConnection : IDisposable
{
    private readonly SseBroadcaster _owner;
    private readonly Guid _userId;

    public Channel<string> Channel { get; } = System.Threading.Channels.Channel.CreateUnbounded<string>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
    public string? ClientSessionId { get; }

    internal SseConnection(SseBroadcaster owner, Guid userId, string? clientSessionId)
    {
        _owner = owner;
        _userId = userId;
        ClientSessionId = clientSessionId;
    }

    public void Dispose() => _owner.Unregister(_userId, this);
}
