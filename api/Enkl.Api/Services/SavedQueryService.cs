using Enkl.Api.Data;
using Enkl.Api.Domain.Entities;
using Enkl.Api.Dtos;
using Microsoft.EntityFrameworkCore;

namespace Enkl.Api.Services;

public class SavedQueryService
{
    private readonly AppDbContext _db;

    public SavedQueryService(AppDbContext db)
    {
        _db = db;
    }

    public async Task<SavedQueryDto?> CreateAsync(Guid projectId, CreateSavedQueryRequest request)
    {
        var projectExists = await _db.Projects.AnyAsync(p => p.Id == projectId);
        if (!projectExists) return null;

        var query = new SavedQuery
        {
            Id = Guid.NewGuid(),
            ProjectId = projectId,
            Name = request.Name,
            Sql = request.Sql,
            DateCreated = DateTime.UtcNow,
            ExposeViaApi = request.ExposeViaApi
        };
        _db.SavedQueries.Add(query);
        await _db.SaveChangesAsync();
        return ToDto(query);
    }

    public async Task<SavedQueryDto?> UpdateAsync(Guid projectId, Guid queryId, CreateSavedQueryRequest request)
    {
        var query = await _db.SavedQueries.FirstOrDefaultAsync(q => q.Id == queryId && q.ProjectId == projectId);
        if (query is null) return null;

        query.Name = request.Name;
        query.Sql = request.Sql;
        query.ExposeViaApi = request.ExposeViaApi;
        await _db.SaveChangesAsync();
        return ToDto(query);
    }

    /// <summary>Raw Sql text for the "Test API" button (Controllers/SavedQueriesController.cs's
    /// Test action) — a dedicated, minimal existence+ownership lookup rather than pulling the whole
    /// SavedQueryDto shape through for one field.</summary>
    public async Task<string?> GetSqlAsync(Guid projectId, Guid queryId)
    {
        return await _db.SavedQueries.AsNoTracking()
            .Where(q => q.Id == queryId && q.ProjectId == projectId)
            .Select(q => q.Sql)
            .FirstOrDefaultAsync();
    }

    public async Task<bool> DeleteAsync(Guid projectId, Guid queryId)
    {
        var query = await _db.SavedQueries.FirstOrDefaultAsync(q => q.Id == queryId && q.ProjectId == projectId);
        if (query is null) return false;

        _db.SavedQueries.Remove(query);
        await _db.SaveChangesAsync();
        return true;
    }

    private static SavedQueryDto ToDto(SavedQuery q) => new(q.Id, q.Name, q.Sql, q.DateCreated, q.ExposeViaApi);
}
