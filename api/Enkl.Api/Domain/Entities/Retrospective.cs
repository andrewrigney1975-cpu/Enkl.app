namespace Enkl.Api.Domain.Entities;

public class Retrospective
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public Guid? ReleaseId { get; set; }
    public Release? Release { get; set; }
    public string Key { get; set; } = "";
    public string? Team { get; set; }
    public string? Background { get; set; }
    public DateOnly? RetroDate { get; set; }
    /// <summary>Last duration the convener set on the countdown timer — a convenience default for
    /// next time, not a live/synced running countdown (the timer itself is entirely client-side).</summary>
    public int? LastTimerDurationSeconds { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }

    public List<RetrospectiveParticipant> Participants { get; set; } = new();
    public List<RetrospectiveItem> Items { get; set; } = new();
    public List<RetrospectiveActionItem> ActionItems { get; set; } = new();
}
