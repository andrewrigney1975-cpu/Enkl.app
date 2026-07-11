namespace Enkl.Api.Dtos;

public record OrganisationPrincipleDto(Guid Id, string Key, string Title, string? Description, string? DocumentUrl, Guid ProjectId, string ProjectName);

public record SharePrincipleRequest(bool IsOrganisationWide);
public record CopyPrincipleRequest(Guid TargetProjectId);

public record PrincipleSuggestionSnippetDto(Guid ProjectId, string ProjectName, Guid RetrospectiveId, string Text);
public record PrincipleSuggestionDto(string Phrase, int OccurrenceCount, int RetrospectiveCount, List<PrincipleSuggestionSnippetDto> SampleSnippets);
