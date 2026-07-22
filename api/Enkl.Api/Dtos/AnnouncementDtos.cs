namespace Enkl.Api.Dtos;

/// <summary>Full shape for the Org-Admin management list — includes fields a plain "active" consumer
/// never needs (Scope/CreatedByVendor aren't rendered in the session-start modal/banner, only in the
/// admin screen).</summary>
public record AnnouncementDto(
    Guid Id, string Scope, string Title, string Body, string Kind,
    DateTime StartAt, DateTime? EndAt, bool CreatedByVendor, DateTime DateCreated);

public record CreateAnnouncementRequest(string Title, string Body, string Kind, DateTime StartAt, DateTime? EndAt);
public record UpdateAnnouncementRequest(string Title, string Body, string Kind, DateTime StartAt, DateTime? EndAt);

/// <summary>What a signed-in user actually sees — deliberately excludes Scope/OrganisationId (an
/// implementation detail of how it was targeted, not something the UI needs) and includes
/// Acknowledged so the frontend can decide modal-vs-already-dismissed without a second round trip.</summary>
public record ActiveAnnouncementDto(
    Guid Id, string Title, string Body, string Kind, DateTime StartAt, DateTime? EndAt, bool Acknowledged);
