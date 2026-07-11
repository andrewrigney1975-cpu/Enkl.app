namespace Enkl.Api.Domain.Entities;

public class RetrospectiveItem
{
    public Guid Id { get; set; }
    public Guid RetrospectiveId { get; set; }
    public Retrospective Retrospective { get; set; } = null!;
    /// <summary>start / stop / keep — same string-enum convention as Release.Status.</summary>
    public string Column { get; set; } = "start";
    public string Text { get; set; } = "";
    public int SortOrder { get; set; }
    /// <summary>Set once this item has been distilled into a Principle — records which one and
    /// drives the "already promoted" UI state.</summary>
    public Guid? PromotedPrincipleId { get; set; }
    public Principle? PromotedPrinciple { get; set; }
    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }
}
