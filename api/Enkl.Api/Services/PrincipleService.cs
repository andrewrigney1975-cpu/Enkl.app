using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class PrincipleService
{
    private readonly AppDbContext _db;

    public PrincipleService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<PrincipleDto?> CreateAsync(Guid projectId, CreatePrincipleRequest request)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var principle = new Principle
        {
            Id = Guid.NewGuid(), ProjectId = projectId, OrganisationId = project.OrganisationId,
            Key = await NextKeyAsync(projectId, project.Key),
            Title = request.Title, Description = request.Description, DocumentUrl = request.DocumentUrl,
            DateCreated = DateTime.UtcNow, DateLastModified = DateTime.UtcNow
        };
        _db.Principles.Add(principle);
        await _db.SaveChangesAsync();
        return ToDto(principle);
    }

    public async Task<PrincipleDto?> UpdateAsync(Guid projectId, Guid principleId, UpdatePrincipleRequest request)
    {
        var principle = await _db.Principles.FirstOrDefaultAsync(p => p.Id == principleId && p.ProjectId == projectId);
        if (principle is null) return null;

        principle.Title = request.Title;
        principle.Description = request.Description;
        principle.DocumentUrl = request.DocumentUrl;
        principle.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return ToDto(principle);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid principleId)
    {
        var principle = await _db.Principles.FirstOrDefaultAsync(p => p.Id == principleId && p.ProjectId == projectId);
        if (principle is null) return false;

        _db.Principles.Remove(principle);
        await _db.SaveChangesAsync();
        return true;
    }

    private async Task<string> NextKeyAsync(Guid projectId, string projectKey)
    {
        var count = await _db.Principles.CountAsync(p => p.ProjectId == projectId);
        return $"{projectKey}-PRIN-{(count + 1):D3}";
    }

    /// <summary>Toggles whether this principle is visible/copyable from the "Organisation Library"
    /// tab in every other project of the same organisation. Sharing never duplicates the row.</summary>
    public async Task<PrincipleDto?> ShareAsync(Guid projectId, Guid principleId, SharePrincipleRequest request)
    {
        var principle = await _db.Principles.FirstOrDefaultAsync(p => p.Id == principleId && p.ProjectId == projectId);
        if (principle is null) return null;

        principle.IsOrganisationWide = request.IsOrganisationWide;
        principle.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return ToDto(principle);
    }

    public async Task<List<OrganisationPrincipleDto>> ListOrganisationWideAsync(Guid organisationId)
    {
        return await _db.Principles
            .Where(p => p.OrganisationId == organisationId && p.IsOrganisationWide)
            .OrderBy(p => p.Title)
            .Select(p => new OrganisationPrincipleDto(p.Id, p.Key, p.Title, p.Description, p.DocumentUrl, p.ProjectId, p.Project.Name))
            .ToListAsync();
    }

    /// <summary>Clones title/description/documentUrl into a brand-new Principle row owned by the
    /// target project — a real independent copy (new Id/Key), not a cross-project reference, so it
    /// can be edited afterwards without affecting the shared original. Both the source principle and
    /// the target project must belong to the caller's own organisation.</summary>
    public async Task<PrincipleDto?> CopyAsync(Guid organisationId, Guid principleId, CopyPrincipleRequest request)
    {
        var source = await _db.Principles.FirstOrDefaultAsync(p => p.Id == principleId && p.OrganisationId == organisationId && p.IsOrganisationWide);
        if (source is null) return null;

        var targetProject = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.TargetProjectId && p.OrganisationId == organisationId);
        if (targetProject is null) return null;

        return await CreateAsync(targetProject.Id, new CreatePrincipleRequest(source.Title, source.Description, source.DocumentUrl));
    }

    /// <summary>
    /// Local, dependency-free "distillation" helper: surfaces retrospective Start-doing/Keep-doing
    /// items that recur across 2+ distinct retrospectives in the organisation as candidate
    /// Principles. Plain unigram/bigram frequency counting — lowercase, strip punctuation, drop a
    /// small hardcoded stopword list — no external NLP/LLM call involved. Already-promoted items are
    /// excluded since they've already become a Principle.
    /// </summary>
    public async Task<List<PrincipleSuggestionDto>> GetSuggestionsAsync(Guid organisationId)
    {
        var items = await _db.RetrospectiveItems
            .Include(i => i.Retrospective).ThenInclude(r => r.Project)
            .Where(i => (i.Column == "start" || i.Column == "keep")
                && i.PromotedPrincipleId == null
                && i.Retrospective.Project.OrganisationId == organisationId)
            .ToListAsync();

        var phrases = new Dictionary<string, PhraseAccumulator>();

        foreach (var item in items)
        {
            var tokens = Tokenize(item.Text);
            var phrasesInThisItem = new HashSet<string>();
            for (var i = 0; i < tokens.Count; i++)
            {
                phrasesInThisItem.Add(tokens[i]);
                if (i < tokens.Count - 1) phrasesInThisItem.Add(tokens[i] + " " + tokens[i + 1]);
            }

            foreach (var phrase in phrasesInThisItem)
            {
                if (!phrases.TryGetValue(phrase, out var acc))
                {
                    acc = new PhraseAccumulator();
                    phrases[phrase] = acc;
                }
                acc.OccurrenceCount++;
                acc.RetrospectiveIds.Add(item.RetrospectiveId);
                if (acc.Samples.Count < 3)
                {
                    acc.Samples.Add(new PrincipleSuggestionSnippetDto(item.Retrospective.ProjectId, item.Retrospective.Project.Name, item.RetrospectiveId, item.Text));
                }
            }
        }

        var candidates = phrases
            .Where(kv => kv.Value.RetrospectiveIds.Count >= 2)
            .Select(kv => new PrincipleSuggestionDto(kv.Key, kv.Value.OccurrenceCount, kv.Value.RetrospectiveIds.Count, kv.Value.Samples))
            .OrderByDescending(s => s.RetrospectiveCount)
            .ThenByDescending(s => s.OccurrenceCount)
            .ThenByDescending(s => s.Phrase.Length)
            .ToList();

        // Prefer multi-word phrases over the single words they're built from — a bigram is a much
        // more informative "suggested principle" title than either of its component unigrams.
        var chosen = new List<PrincipleSuggestionDto>();
        var coveredWords = new HashSet<string>();
        foreach (var candidate in candidates)
        {
            if (chosen.Count >= 10) break;
            var words = candidate.Phrase.Split(' ');
            if (words.Length == 1 && coveredWords.Contains(words[0])) continue;
            chosen.Add(candidate);
            foreach (var w in words) coveredWords.Add(w);
        }

        return chosen;
    }

    private static readonly HashSet<string> Stopwords = new(new[]
    {
        "a","an","the","and","or","but","if","then","of","to","in","on","for","with","at","by","from",
        "up","about","into","over","after","we","our","us","i","you","your","it","its","this","that",
        "these","those","is","are","was","were","be","been","being","have","has","had","do","does","did",
        "not","no","so","as","more","less","very","just","also","should","could","would","can","will",
        "there","which","who","what","when","how"
    });

    private static List<string> Tokenize(string text)
    {
        var lowered = (text ?? "").ToLowerInvariant();
        var cleaned = System.Text.RegularExpressions.Regex.Replace(lowered, "[^a-z0-9\\s]", " ");
        return cleaned.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 2 && !Stopwords.Contains(t))
            .ToList();
    }

    private class PhraseAccumulator
    {
        public int OccurrenceCount;
        public HashSet<Guid> RetrospectiveIds { get; } = new();
        public List<PrincipleSuggestionSnippetDto> Samples { get; } = new();
    }

    private static PrincipleDto ToDto(Principle p) => new(p.Id, p.Key, p.Title, p.Description, p.DocumentUrl, p.IsOrganisationWide);
}
