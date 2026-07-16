using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Enkl.Api.Validation;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class RetrospectiveService
{
    private readonly AppDbContext _db;
    private readonly PrincipleService _principles;

    public RetrospectiveService(AppDbContext db, PrincipleService principles)
    {
        _db = db;
        _principles = principles;
    }

    private static readonly string[] ValidColumns = { "start", "stop", "keep" };

    public async Task<RetrospectiveDto?> CreateAsync(Guid projectId, CreateRetrospectiveRequest request)
    {
        var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId);
        if (project is null) return null;

        var now = DateTime.UtcNow;
        var retro = new Retrospective
        {
            Id = Guid.NewGuid(), ProjectId = projectId, Key = await NextKeyAsync(projectId, project.Key),
            ReleaseId = request.ReleaseId, Team = request.Team, Background = request.Background, RetroDate = request.RetroDate,
            DateCreated = now, DateLastModified = now
        };
        _db.Retrospectives.Add(retro);
        ApplyParticipants(retro, request.ParticipantIds);
        await _db.SaveChangesAsync();

        return ProjectService.ToRetrospectiveDto(retro);
    }

    public async Task<RetrospectiveDto?> UpdateAsync(Guid projectId, Guid retrospectiveId, UpdateRetrospectiveRequest request)
    {
        var retro = await LoadAsync(projectId, retrospectiveId);
        if (retro is null) return null;

        retro.ReleaseId = request.ReleaseId;
        retro.Team = request.Team;
        retro.Background = request.Background;
        retro.RetroDate = request.RetroDate;
        if (request.LastTimerDurationSeconds.HasValue) retro.LastTimerDurationSeconds = request.LastTimerDurationSeconds;
        retro.DateLastModified = DateTime.UtcNow;
        ApplyParticipants(retro, request.ParticipantIds);
        await _db.SaveChangesAsync();

        return ProjectService.ToRetrospectiveDto(retro);
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid retrospectiveId)
    {
        var retro = await _db.Retrospectives.FirstOrDefaultAsync(r => r.Id == retrospectiveId && r.ProjectId == projectId);
        if (retro is null) return false;

        _db.Retrospectives.Remove(retro);
        await _db.SaveChangesAsync();
        return true;
    }

    public async Task<RetrospectiveItemDto?> CreateItemAsync(Guid projectId, Guid retrospectiveId, CreateRetrospectiveItemRequest request)
    {
        var retroExists = await _db.Retrospectives.AnyAsync(r => r.Id == retrospectiveId && r.ProjectId == projectId);
        if (!retroExists) return null;

        var now = DateTime.UtcNow;
        var nextOrder = await _db.RetrospectiveItems.Where(i => i.RetrospectiveId == retrospectiveId).CountAsync();
        var item = new RetrospectiveItem
        {
            Id = Guid.NewGuid(), RetrospectiveId = retrospectiveId,
            Column = NormalizeColumn(request.Column), Text = request.Text ?? "", SortOrder = nextOrder,
            DateCreated = now, DateLastModified = now
        };
        _db.RetrospectiveItems.Add(item);
        await _db.SaveChangesAsync();

        return ToItemDto(item);
    }

    public async Task<RetrospectiveItemDto?> UpdateItemAsync(Guid projectId, Guid retrospectiveId, Guid itemId, UpdateRetrospectiveItemRequest request)
    {
        var item = await _db.RetrospectiveItems
            .Include(i => i.Retrospective)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.RetrospectiveId == retrospectiveId && i.Retrospective.ProjectId == projectId);
        if (item is null) return null;

        item.Column = NormalizeColumn(request.Column);
        item.Text = request.Text ?? "";
        item.SortOrder = request.SortOrder;
        item.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return ToItemDto(item);
    }

    public async Task<bool> DeleteItemAsync(Guid projectId, Guid retrospectiveId, Guid itemId)
    {
        var item = await _db.RetrospectiveItems
            .Include(i => i.Retrospective)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.RetrospectiveId == retrospectiveId && i.Retrospective.ProjectId == projectId);
        if (item is null) return false;

        _db.RetrospectiveItems.Remove(item);
        await _db.SaveChangesAsync();
        return true;
    }

    /// <summary>Distills a Start/Keep-doing item into a Principle (via the existing
    /// PrincipleService, so a shared org-wide Principle library sees it too), then links the item
    /// back to the new Principle so the UI can show it as already promoted.</summary>
    // ARCHITECTURE-REVIEW.md finding 2.2 (transaction audit): _principles.CreateAsync() commits its
    // own SaveChangesAsync() immediately, and this method then does a SECOND, separate
    // SaveChangesAsync() to link item.PromotedPrincipleId to the new row — without an explicit
    // transaction wrapping both, a failure on the second save would leave a real, unlinked Principle
    // behind while the retrospective item never shows as promoted. Wrapped the same way
    // MigrationService.MigrateAsync does for its own multi-step writes.
    public async Task<PromoteRetrospectiveItemResponseDto?> PromoteItemAsync(Guid projectId, Guid retrospectiveId, Guid itemId, PromoteRetrospectiveItemRequest request)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync();

        var item = await _db.RetrospectiveItems
            .Include(i => i.Retrospective)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.RetrospectiveId == retrospectiveId && i.Retrospective.ProjectId == projectId);
        if (item is null) return null;

        var title = (request.Title ?? "").Trim();
        if (title.Length == 0) throw new ApiValidationException("Please enter a principle title.");

        var principle = await _principles.CreateAsync(projectId, new CreatePrincipleRequest(title, request.Description, null));
        if (principle is null) return null;

        item.PromotedPrincipleId = principle.Id;
        item.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        await transaction.CommitAsync();

        return new PromoteRetrospectiveItemResponseDto(principle, ToItemDto(item));
    }

    public async Task<RetrospectiveActionItemDto?> CreateActionItemAsync(Guid projectId, Guid retrospectiveId, CreateRetrospectiveActionItemRequest request)
    {
        var retroExists = await _db.Retrospectives.AnyAsync(r => r.Id == retrospectiveId && r.ProjectId == projectId);
        if (!retroExists) return null;

        var now = DateTime.UtcNow;
        var nextOrder = await _db.RetrospectiveActionItems.Where(i => i.RetrospectiveId == retrospectiveId).CountAsync();
        var item = new RetrospectiveActionItem
        {
            Id = Guid.NewGuid(), RetrospectiveId = retrospectiveId,
            Text = request.Text ?? "", AssigneeId = request.AssigneeId, Completed = false, SortOrder = nextOrder,
            DateCreated = now, DateLastModified = now
        };
        _db.RetrospectiveActionItems.Add(item);
        await _db.SaveChangesAsync();

        return ToActionItemDto(item);
    }

    public async Task<RetrospectiveActionItemDto?> UpdateActionItemAsync(Guid projectId, Guid retrospectiveId, Guid itemId, UpdateRetrospectiveActionItemRequest request)
    {
        var item = await _db.RetrospectiveActionItems
            .Include(i => i.Retrospective)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.RetrospectiveId == retrospectiveId && i.Retrospective.ProjectId == projectId);
        if (item is null) return null;

        item.Text = request.Text ?? "";
        item.AssigneeId = request.AssigneeId;
        item.Completed = request.Completed;
        item.SortOrder = request.SortOrder;
        item.DateLastModified = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return ToActionItemDto(item);
    }

    public async Task<bool> DeleteActionItemAsync(Guid projectId, Guid retrospectiveId, Guid itemId)
    {
        var item = await _db.RetrospectiveActionItems
            .Include(i => i.Retrospective)
            .FirstOrDefaultAsync(i => i.Id == itemId && i.RetrospectiveId == retrospectiveId && i.Retrospective.ProjectId == projectId);
        if (item is null) return false;

        _db.RetrospectiveActionItems.Remove(item);
        await _db.SaveChangesAsync();
        return true;
    }

    private async Task<Retrospective?> LoadAsync(Guid projectId, Guid retrospectiveId)
    {
        return await _db.Retrospectives
            .Include(r => r.Participants)
            .Include(r => r.Items)
            .Include(r => r.ActionItems)
            .FirstOrDefaultAsync(r => r.Id == retrospectiveId && r.ProjectId == projectId);
    }

    private void ApplyParticipants(Retrospective retro, List<Guid>? participantIds)
    {
        var wanted = (participantIds ?? new List<Guid>()).Distinct().ToHashSet();
        retro.Participants.RemoveAll(p => !wanted.Contains(p.ProjectMemberId));
        var existing = retro.Participants.Select(p => p.ProjectMemberId).ToHashSet();
        foreach (var memberId in wanted.Where(id => !existing.Contains(id)))
        {
            retro.Participants.Add(new RetrospectiveParticipant { RetrospectiveId = retro.Id, ProjectMemberId = memberId });
        }
    }

    private static string NormalizeColumn(string? column) => ValidColumns.Contains(column) ? column! : "start";

    private async Task<string> NextKeyAsync(Guid projectId, string projectKey)
    {
        var count = await _db.Retrospectives.CountAsync(r => r.ProjectId == projectId);
        return $"{projectKey}-RETRO-{(count + 1):D3}";
    }

    private static RetrospectiveItemDto ToItemDto(RetrospectiveItem i) => new(i.Id, i.Column, i.Text, i.SortOrder, i.PromotedPrincipleId);
    private static RetrospectiveActionItemDto ToActionItemDto(RetrospectiveActionItem a) => new(a.Id, a.Text, a.AssigneeId, a.Completed, a.SortOrder);
}
