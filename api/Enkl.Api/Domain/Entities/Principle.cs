namespace Enkl.Api.Domain.Entities;

public class Principle
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    /// <summary>Denormalized from Project.OrganisationId at creation time so the organisation-wide
    /// library and suggestions queries can filter directly without joining through Projects.</summary>
    public Guid OrganisationId { get; set; }
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string? DocumentUrl { get; set; }
    /// <summary>Opt-in per principle: when true, this row is visible/copyable from any project in
    /// the organisation via the "Organisation Library" tab. Sharing a principle never duplicates it
    /// — it stays the one row, just visible more widely.</summary>
    public bool IsOrganisationWide { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }
}
