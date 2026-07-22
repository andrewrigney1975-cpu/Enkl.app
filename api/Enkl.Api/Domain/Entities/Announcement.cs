namespace Enkl.Api.Domain.Entities;

/// <summary>
/// Org-Admin (or vendor-staff, via the standalone Vendor Portal writing directly into this same
/// table) broadcast message. Org-scoped like PortfolioCategory/ChatChannel — FK only, no back-nav
/// collection on Organisation (see AnnouncementConfiguration's own comment). Scope decides how
/// OrganisationId/AnnouncementOrganisations get interpreted:
///   - "org"      — the normal Org-Admin case. OrganisationId is set, no join rows.
///   - "orgs"     — vendor-authored, targeted at specific organisations. OrganisationId is null;
///                  Organisations lives are in the AnnouncementOrganisations join table instead.
///   - "platform" — vendor-authored, applies to every organisation. OrganisationId null, no join rows.
/// Kind distinguishes the two DISPLAY behaviors: "announcement" (session-start modal, dismissible
/// per-user via AnnouncementAcknowledgements) vs "disruption" (persistent top-of-page banner, never
/// dismissed — it simply stops showing once EndAt passes).
/// </summary>
public class Announcement
{
    public Guid Id { get; set; }
    public string Scope { get; set; } = "org";
    public Guid? OrganisationId { get; set; }
    public Organisation? Organisation { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public string Kind { get; set; } = "announcement";
    public DateTime StartAt { get; set; }
    public DateTime? EndAt { get; set; }

    // Nullable, SetNull — an Org Admin who later leaves the org shouldn't take their past
    // announcements down with them, same resilience pattern as TaskComment.AuthorId.
    public Guid? CreatedByUserId { get; set; }
    public User? CreatedByUser { get; set; }

    // The only provenance marker for a vendor-authored row (CreatedByUserId is always null there —
    // the Vendor Portal has no Enkl User/login concept of its own, see its own CLAUDE.md).
    public bool CreatedByVendor { get; set; }

    public DateTime DateCreated { get; set; }
    public DateTime DateLastModified { get; set; }

    public List<AnnouncementOrganisation> TargetOrganisations { get; set; } = new();
    public List<AnnouncementAcknowledgement> Acknowledgements { get; set; } = new();
}

/// <summary>Join row: which Organisations a Scope="orgs" Announcement is targeted at — only ever
/// populated for vendor-authored, multi-org-targeted rows (see Announcement's own doc comment).</summary>
public class AnnouncementOrganisation
{
    public Guid Id { get; set; }
    public Guid AnnouncementId { get; set; }
    public Announcement Announcement { get; set; } = null!;
    public Guid OrganisationId { get; set; }
    public Organisation Organisation { get; set; } = null!;
}

/// <summary>Per-user "don't show this again" — only ever written for Kind="announcement" (a
/// disruption notice is never acknowledged/dismissed; it just stops showing once EndAt passes).
/// Mirrors ChatChannelMember's join-row shape.</summary>
public class AnnouncementAcknowledgement
{
    public Guid Id { get; set; }
    public Guid AnnouncementId { get; set; }
    public Announcement Announcement { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public DateTime AcknowledgedAt { get; set; }
}
