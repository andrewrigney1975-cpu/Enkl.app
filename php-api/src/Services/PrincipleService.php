<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Support\Uuid;
use PDO;

/** Ported from Services/PrincipleService.cs. */
final class PrincipleService
{
    public function __construct(private readonly PDO $db)
    {
    }

    public function create(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key", "OrganisationId" FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $id = Uuid::v4();
        $key = $this->nextKey($projectId, $project['Key']);
        $this->db->prepare(<<<SQL
            INSERT INTO "Principles" ("Id", "ProjectId", "OrganisationId", "Key", "Title", "Description", "DocumentUrl", "IsOrganisationWide", "DateCreated", "DateLastModified")
            VALUES (:id, :pid, :orgId, :key, :title, :description, :docUrl, false, now(), now())
        SQL)->execute([
            'id' => $id, 'pid' => $projectId, 'orgId' => $project['OrganisationId'], 'key' => $key,
            'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'docUrl' => $request['documentUrl'] ?? null,
        ]);

        return [
            'id' => $id, 'key' => $key, 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'documentUrl' => $request['documentUrl'] ?? null, 'isOrganisationWide' => false,
        ];
    }

    public function update(string $projectId, string $principleId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT "Key", "IsOrganisationWide" FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $principleId, 'pid' => $projectId]);
        $existing = $stmt->fetch();
        if ($existing === false) {
            return null;
        }

        $this->db->prepare('UPDATE "Principles" SET "Title" = :title, "Description" = :description, "DocumentUrl" = :docUrl, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['title' => $request['title'] ?? '', 'description' => $request['description'] ?? null, 'docUrl' => $request['documentUrl'] ?? null, 'id' => $principleId]);

        return [
            'id' => $principleId, 'key' => $existing['Key'], 'title' => $request['title'] ?? '', 'description' => $request['description'] ?? null,
            'documentUrl' => $request['documentUrl'] ?? null, 'isOrganisationWide' => (bool) $existing['IsOrganisationWide'],
        ];
    }

    public function delete(string $projectId, string $principleId): bool
    {
        $stmt = $this->db->prepare('DELETE FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $principleId, 'pid' => $projectId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Toggles whether this principle is visible/copyable from the "Organisation Library" tab in
     * every other project of the same organisation. Sharing never duplicates the row.
     */
    public function share(string $projectId, string $principleId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Principles" WHERE "Id" = :id AND "ProjectId" = :pid');
        $stmt->execute(['id' => $principleId, 'pid' => $projectId]);
        $existing = $stmt->fetch();
        if ($existing === false) {
            return null;
        }

        $isWide = (bool) ($request['isOrganisationWide'] ?? false);
        // (int), not the raw PHP bool — see ColumnService::create's comment on why.
        $this->db->prepare('UPDATE "Principles" SET "IsOrganisationWide" = :isWide, "DateLastModified" = now() WHERE "Id" = :id')
            ->execute(['isWide' => (int) $isWide, 'id' => $principleId]);

        return [
            'id' => $existing['Id'], 'key' => $existing['Key'], 'title' => $existing['Title'],
            'description' => $existing['Description'], 'documentUrl' => $existing['DocumentUrl'], 'isOrganisationWide' => $isWide,
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public function listOrganisationWide(string $organisationId): array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT p.*, pr."Name" AS "ProjectName" FROM "Principles" p
            JOIN "Projects" pr ON pr."Id" = p."ProjectId"
            WHERE p."OrganisationId" = :oid AND p."IsOrganisationWide" = true
            ORDER BY p."Title"
        SQL);
        $stmt->execute(['oid' => $organisationId]);

        return array_map(static fn(array $p): array => [
            'id' => $p['Id'], 'key' => $p['Key'], 'title' => $p['Title'], 'description' => $p['Description'],
            'documentUrl' => $p['DocumentUrl'], 'projectId' => $p['ProjectId'], 'projectName' => $p['ProjectName'],
        ], $stmt->fetchAll());
    }

    /**
     * Clones title/description/documentUrl into a brand-new Principle row owned by the target
     * project — a real independent copy (new Id/Key), not a cross-project reference, so it can be
     * edited afterwards without affecting the shared original. Both the source principle and the
     * target project must belong to the caller's own organisation.
     */
    public function copy(string $organisationId, string $principleId, array $request): ?array
    {
        $stmt = $this->db->prepare(
            'SELECT * FROM "Principles" WHERE "Id" = :id AND "OrganisationId" = :oid AND "IsOrganisationWide" = true'
        );
        $stmt->execute(['id' => $principleId, 'oid' => $organisationId]);
        $source = $stmt->fetch();
        if ($source === false) {
            return null;
        }

        $targetProjectId = (string) ($request['targetProjectId'] ?? '');
        $targetStmt = $this->db->prepare('SELECT "Id" FROM "Projects" WHERE "Id" = :id AND "OrganisationId" = :oid');
        $targetStmt->execute(['id' => $targetProjectId, 'oid' => $organisationId]);
        $targetProject = $targetStmt->fetch();
        if ($targetProject === false) {
            return null;
        }

        return $this->create($targetProject['Id'], [
            'title' => $source['Title'], 'description' => $source['Description'], 'documentUrl' => $source['DocumentUrl'],
        ]);
    }

    /**
     * Local, dependency-free "distillation" helper: surfaces retrospective Start-doing/Keep-doing
     * items that recur across 2+ distinct retrospectives in the organisation as candidate
     * Principles. Plain unigram/bigram frequency counting — lowercase, strip punctuation, drop a
     * small hardcoded stopword list — no external NLP/LLM call involved. Already-promoted items are
     * excluded since they've already become a Principle.
     *
     * @return array<int, array<string, mixed>>
     */
    public function getSuggestions(string $organisationId): array
    {
        $stmt = $this->db->prepare(<<<SQL
            SELECT i."Id", i."Text", i."RetrospectiveId", r."ProjectId", pr."Name" AS "ProjectName"
            FROM "RetrospectiveItems" i
            JOIN "Retrospectives" r ON r."Id" = i."RetrospectiveId"
            JOIN "Projects" pr ON pr."Id" = r."ProjectId"
            WHERE (i."Column" = 'start' OR i."Column" = 'keep')
                AND i."PromotedPrincipleId" IS NULL
                AND pr."OrganisationId" = :oid
        SQL);
        $stmt->execute(['oid' => $organisationId]);
        $items = $stmt->fetchAll();

        /** @var array<string, array{occurrenceCount:int, retrospectiveIds:array<string,bool>, samples:array<int,array<string,mixed>>}> $phrases */
        $phrases = [];

        foreach ($items as $item) {
            $tokens = $this->tokenize($item['Text']);
            $phrasesInThisItem = [];
            $tokenCount = count($tokens);
            for ($i = 0; $i < $tokenCount; $i++) {
                $phrasesInThisItem[$tokens[$i]] = true;
                if ($i < $tokenCount - 1) {
                    $phrasesInThisItem[$tokens[$i] . ' ' . $tokens[$i + 1]] = true;
                }
            }

            foreach (array_keys($phrasesInThisItem) as $phrase) {
                if (!isset($phrases[$phrase])) {
                    $phrases[$phrase] = ['occurrenceCount' => 0, 'retrospectiveIds' => [], 'samples' => []];
                }
                $phrases[$phrase]['occurrenceCount']++;
                $phrases[$phrase]['retrospectiveIds'][$item['RetrospectiveId']] = true;
                if (count($phrases[$phrase]['samples']) < 3) {
                    $phrases[$phrase]['samples'][] = [
                        'projectId' => $item['ProjectId'], 'projectName' => $item['ProjectName'],
                        'retrospectiveId' => $item['RetrospectiveId'], 'text' => $item['Text'],
                    ];
                }
            }
        }

        $candidates = [];
        foreach ($phrases as $phrase => $acc) {
            $retroCount = count($acc['retrospectiveIds']);
            if ($retroCount < 2) {
                continue;
            }
            $candidates[] = [
                'phrase' => $phrase, 'occurrenceCount' => $acc['occurrenceCount'],
                'retrospectiveCount' => $retroCount, 'sampleSnippets' => $acc['samples'],
            ];
        }

        usort($candidates, static function (array $a, array $b): int {
            return $b['retrospectiveCount'] <=> $a['retrospectiveCount']
                ?: $b['occurrenceCount'] <=> $a['occurrenceCount']
                ?: strlen($b['phrase']) <=> strlen($a['phrase']);
        });

        // Prefer multi-word phrases over the single words they're built from — a bigram is a much
        // more informative "suggested principle" title than either of its component unigrams.
        $chosen = [];
        $coveredWords = [];
        foreach ($candidates as $candidate) {
            if (count($chosen) >= 10) {
                break;
            }
            $words = explode(' ', $candidate['phrase']);
            if (count($words) === 1 && isset($coveredWords[$words[0]])) {
                continue;
            }
            $chosen[] = $candidate;
            foreach ($words as $w) {
                $coveredWords[$w] = true;
            }
        }

        return $chosen;
    }

    private const STOPWORDS = [
        'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
        'up', 'about', 'into', 'over', 'after', 'we', 'our', 'us', 'i', 'you', 'your', 'it', 'its', 'this', 'that',
        'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
        'not', 'no', 'so', 'as', 'more', 'less', 'very', 'just', 'also', 'should', 'could', 'would', 'can', 'will',
        'there', 'which', 'who', 'what', 'when', 'how',
    ];

    /** @return string[] */
    private function tokenize(?string $text): array
    {
        $lowered = strtolower($text ?? '');
        $cleaned = preg_replace('/[^a-z0-9\s]/', ' ', $lowered);
        $tokens = preg_split('/\s+/', trim((string) $cleaned), -1, PREG_SPLIT_NO_EMPTY);
        $stopwords = array_flip(self::STOPWORDS);
        return array_values(array_filter($tokens ?: [], static fn(string $t): bool => strlen($t) > 2 && !isset($stopwords[$t])));
    }

    private function nextKey(string $projectId, string $projectKey): string
    {
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM "Principles" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        $count = (int) $stmt->fetchColumn();
        return sprintf('%s-PRIN-%03d', $projectKey, $count + 1);
    }
}
