<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\SqlDateTime;
use Enkl\Api\Support\Uuid;
use Enkl\Api\Validation\ApiValidationException;
use PDO;

/**
 * Ported from Services/TaskCommentService.cs — see that file's own comments for the "why" behind
 * each piece.
 *
 * Create: any project member. Author is NEVER accepted from the client — always derived from the
 * caller's own ProjectMembers row; if the caller has no such row (the Org-Admin-without-membership
 * edge case), there's no valid author to stamp and creation is rejected.
 *
 * Update: author-only — filtered by AuthorId == caller's own ProjectMember.Id in the query itself,
 * same "return null rather than throw a separate 403" shape as ToDoService's owner-only checks.
 *
 * Delete: author OR Project Admin OR Org Admin — the admin half mirrors ProjectAdminMiddleware's own
 * live-DB check, inlined here since these routes only require plain ProjectMemberMiddleware.
 */
final class TaskCommentService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function create(string $projectId, string $taskId, string $callerUserId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM "Tasks" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $taskId, 'pid' => $projectId]);
        if ($stmt->fetch() === false) {
            return null;
        }

        $memberStmt = $this->db->prepare(
            'SELECT m."Id" AS "MemberId", u."DisplayName" FROM "ProjectMembers" m JOIN "Users" u ON u."Id" = m."UserId" WHERE m."ProjectId" = :pid AND m."UserId" = :uid'
        );
        $memberStmt->execute(['pid' => $projectId, 'uid' => $callerUserId]);
        $member = $memberStmt->fetch();
        if ($member === false) {
            throw new ApiValidationException('You must be a member of this project to comment.');
        }

        $text = trim((string) ($request['text'] ?? ''));
        if ($text === '') {
            throw new ApiValidationException('Comment text is required.');
        }

        $commentId = Uuid::v4();
        // $dateCreated stays ISO-8601 (returned to the caller below, matching the other two tiers'
        // response shape exactly) — only the bound SQL parameter needs MariaDB's own DATETIME literal
        // form (see SqlDateTime's own doc comment for why the two representations must differ).
        $dateCreated = gmdate('Y-m-d\TH:i:s\Z');
        $stmt = $this->db->prepare(
            'INSERT INTO "TaskComments" ("Id", "TaskId", "Text", "DateCreated", "AuthorId", "AuthorName") VALUES (:id, :tid, :text, :dc, :aid, :aname)'
        );
        $stmt->execute([
            'id' => $commentId, 'tid' => $taskId, 'text' => $text, 'dc' => SqlDateTime::reformat($dateCreated),
            'aid' => $member['MemberId'], 'aname' => $member['DisplayName'],
        ]);

        return ['id' => $commentId, 'text' => $text, 'dateCreated' => $dateCreated, 'authorId' => $member['MemberId'], 'authorName' => $member['DisplayName']];
    }

    public function update(string $projectId, string $taskId, string $commentId, string $callerUserId, array $request): ?array
    {
        $memberStmt = $this->db->prepare('SELECT "Id" FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
        $memberStmt->execute(['pid' => $projectId, 'uid' => $callerUserId]);
        $member = $memberStmt->fetch();
        if ($member === false) {
            return null;
        }

        $stmt = $this->db->prepare(<<<SQL
            SELECT c.* FROM "TaskComments" c JOIN "Tasks" t ON t."Id" = c."TaskId"
            WHERE c."Id" = :id AND c."TaskId" = :tid AND t."ProjectId" = :pid AND c."AuthorId" = :aid
        SQL);
        $stmt->execute(['id' => $commentId, 'tid' => $taskId, 'pid' => $projectId, 'aid' => $member['Id']]);
        $comment = $stmt->fetch();
        if ($comment === false) {
            return null;
        }

        $text = trim((string) ($request['text'] ?? ''));
        if ($text === '') {
            throw new ApiValidationException('Comment text is required.');
        }

        $this->db->prepare('UPDATE "TaskComments" SET "Text" = :text WHERE "Id" = :id')->execute(['text' => $text, 'id' => $commentId]);

        return ['id' => $commentId, 'text' => $text, 'dateCreated' => $comment['DateCreated'], 'authorId' => $comment['AuthorId'], 'authorName' => $comment['AuthorName']];
    }

    public function delete(string $projectId, string $taskId, string $commentId, string $callerUserId, bool $callerClaimsOrgAdmin, ?string $callerOrgId): bool
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT c."Id", c."AuthorId" FROM "TaskComments" c JOIN "Tasks" t ON t."Id" = c."TaskId"
            WHERE c."Id" = :id AND c."TaskId" = :tid AND t."ProjectId" = :pid
        SQL);
        $stmt->execute(['id' => $commentId, 'tid' => $taskId, 'pid' => $projectId]);
        $comment = $stmt->fetch();
        if ($comment === false) {
            return false;
        }

        $memberStmt = $this->db->prepare('SELECT "Id", "IsProjectAdmin" FROM "ProjectMembers" WHERE "ProjectId" = :pid AND "UserId" = :uid');
        $memberStmt->execute(['pid' => $projectId, 'uid' => $callerUserId]);
        $member = $memberStmt->fetch();

        $isAuthor = $member !== false && $comment['AuthorId'] === $member['Id'];
        $isAdmin = ($member !== false && (bool) $member['IsProjectAdmin'])
            || $this->isOrgAdminForProject($projectId, $callerClaimsOrgAdmin, $callerOrgId);

        if (!$isAuthor && !$isAdmin) {
            return false;
        }

        $this->db->prepare('DELETE FROM "TaskComments" WHERE "Id" = :id')->execute(['id' => $commentId]);
        return true;
    }

    private function isOrgAdminForProject(string $projectId, bool $callerClaimsOrgAdmin, ?string $callerOrgId): bool
    {
        if (!$callerClaimsOrgAdmin || $callerOrgId === null) {
            return false;
        }
        $stmt = $this->db->prepare('SELECT 1 FROM "Projects" WHERE "Id" = :pid AND "OrganisationId" = :orgId');
        $stmt->execute(['pid' => $projectId, 'orgId' => $callerOrgId]);
        return $stmt->fetch() !== false;
    }
}
