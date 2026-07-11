namespace Enkl.Api.Domain.Entities;

/* Explicit join entities (rather than EF Core's implicit skip-navigation many-to-many) so each
   relationship gets its own named table and composite key, matching the *Ids arrays on the local
   export.js shape one-for-one. None of these carry extra columns beyond the two FKs. */

public class DocumentRelation
{
    public Guid DocumentId { get; set; }
    public Document Document { get; set; } = null!;
    public Guid RelatedDocumentId { get; set; }
    public Document RelatedDocument { get; set; } = null!;
}

public class RiskDocument
{
    public Guid RiskId { get; set; }
    public Risk Risk { get; set; } = null!;
    public Guid DocumentId { get; set; }
    public Document Document { get; set; } = null!;
}

public class RiskPrinciple
{
    public Guid RiskId { get; set; }
    public Risk Risk { get; set; } = null!;
    public Guid PrincipleId { get; set; }
    public Principle Principle { get; set; } = null!;
}

public class RiskObjective
{
    public Guid RiskId { get; set; }
    public Risk Risk { get; set; } = null!;
    public Guid ObjectiveId { get; set; }
    public Objective Objective { get; set; } = null!;
}

public class ObjectivePrinciple
{
    public Guid ObjectiveId { get; set; }
    public Objective Objective { get; set; } = null!;
    public Guid PrincipleId { get; set; }
    public Principle Principle { get; set; } = null!;
}

public class TeamCommitteeMember
{
    public Guid TeamCommitteeId { get; set; }
    public TeamCommittee TeamCommittee { get; set; } = null!;
    public Guid ProjectMemberId { get; set; }
    public ProjectMember ProjectMember { get; set; } = null!;
}

public class OrgTeamMember
{
    public Guid OrgTeamId { get; set; }
    public OrgTeam OrgTeam { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
}

public class DecisionDocument
{
    public Guid DecisionId { get; set; }
    public Decision Decision { get; set; } = null!;
    public Guid DocumentId { get; set; }
    public Document Document { get; set; } = null!;
}

public class DecisionRisk
{
    public Guid DecisionId { get; set; }
    public Decision Decision { get; set; } = null!;
    public Guid RiskId { get; set; }
    public Risk Risk { get; set; } = null!;
}

public class DecisionPrinciple
{
    public Guid DecisionId { get; set; }
    public Decision Decision { get; set; } = null!;
    public Guid PrincipleId { get; set; }
    public Principle Principle { get; set; } = null!;
}

public class DecisionObjective
{
    public Guid DecisionId { get; set; }
    public Decision Decision { get; set; } = null!;
    public Guid ObjectiveId { get; set; }
    public Objective Objective { get; set; } = null!;
}

public class TaskDependency
{
    public Guid TaskId { get; set; }
    public TaskItem Task { get; set; } = null!;
    public Guid DependsOnTaskId { get; set; }
    public TaskItem DependsOnTask { get; set; } = null!;
}

public class RetrospectiveParticipant
{
    public Guid RetrospectiveId { get; set; }
    public Retrospective Retrospective { get; set; } = null!;
    public Guid ProjectMemberId { get; set; }
    public ProjectMember ProjectMember { get; set; } = null!;
}
