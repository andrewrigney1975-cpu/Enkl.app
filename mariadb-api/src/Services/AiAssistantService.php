<?php

declare(strict_types=1);

namespace Enkl\Api\Services;

use Enkl\Api\Config\Config;
use Enkl\Api\Support\Log;
use PDO;

/**
 * Ported from php-api/src/Services/AiAssistantService.php (itself ported from Services/
 * AiAssistantService.cs) — see that file's own doc comment for the tool-loop shape and security
 * model. One real dialect divergence from the Postgres tier: findTask() below uses
 * LOWER(...) LIKE LOWER(...) instead of ILIKE, which MariaDB doesn't support (see mariadb-api/
 * CLAUDE.md §2 for why the rest of this file's raw SQL ports over unchanged under ANSI_QUOTES).
 */
final class AiAssistantService
{
    private const PRIORITY_ORDER = ['trivial', 'low', 'medium', 'high', 'critical'];
    private const MAX_TOOL_LOOP_ITERATIONS = 6;

    public function __construct(private readonly PDO $db)
    {
    }

    /** @return array{reply: string, actions: array<int, array<string, mixed>>}|null */
    public function chat(string $projectId, array $request): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Projects" WHERE "Id" = :id');
        $stmt->execute(['id' => $projectId]);
        $project = $stmt->fetch();
        if ($project === false) {
            return null;
        }

        $apiKey = Config::get('ANTHROPIC_API_KEY', '');
        if ($apiKey === null || $apiKey === '') {
            throw new \RuntimeException('ANTHROPIC_API_KEY is not configured — the AI assistant is unavailable until an API key is set.');
        }

        $columns = $this->fetchColumns($projectId);
        $members = $this->fetchMembers($projectId);
        $taskTypes = $this->fetchTaskTypes($projectId);
        $systemPrompt = $this->buildSystemPrompt($project['Name'], $columns, $members, $taskTypes, $request['alertsSummary'] ?? null);

        $messages = [];
        foreach (($request['messages'] ?? []) as $m) {
            $messages[] = ['role' => $m['role'], 'content' => $m['content']];
        }

        $actions = [];

        for ($iteration = 0; $iteration < self::MAX_TOOL_LOOP_ITERATIONS; $iteration++) {
            $body = [
                'model' => 'claude-sonnet-5',
                'max_tokens' => 2000,
                'system' => $systemPrompt,
                'messages' => $messages,
                'tools' => $this->toolDefinitions(),
                'output_config' => ['effort' => 'low'],
            ];

            $response = $this->callAnthropic($apiKey, $body);
            $stopReason = $response['stop_reason'] ?? null;
            $contentBlocks = $response['content'] ?? [];

            $toolUseBlocks = array_values(array_filter($contentBlocks, static fn(array $b) => ($b['type'] ?? null) === 'tool_use'));
            $replyText = implode('', array_map(
                static fn(array $b) => $b['text'] ?? '',
                array_filter($contentBlocks, static fn(array $b) => ($b['type'] ?? null) === 'text')
            ));

            if ($stopReason !== 'tool_use' || $toolUseBlocks === []) {
                return ['reply' => $replyText, 'actions' => $actions];
            }

            // Echo the assistant's turn (including tool_use blocks) back, then append one user turn
            // carrying every tool_result — parallel tool calls must return in a single message.
            $messages[] = ['role' => 'assistant', 'content' => $contentBlocks];

            $toolResults = [];
            foreach ($toolUseBlocks as $toolUse) {
                $toolName = $toolUse['name'];
                $toolUseId = $toolUse['id'];
                $input = $toolUse['input'] ?? [];

                [$resultText, $isError, $action] = $this->executeTool($projectId, $toolName, $input);
                if ($action !== null) {
                    $actions[] = $action;
                }

                $toolResult = ['type' => 'tool_result', 'tool_use_id' => $toolUseId, 'content' => $resultText];
                if ($isError) {
                    $toolResult['is_error'] = true;
                }
                $toolResults[] = $toolResult;
            }

            $messages[] = ['role' => 'user', 'content' => $toolResults];
        }

        return ['reply' => "I wasn't able to finish that within the allotted number of steps — could you try a narrower request?", 'actions' => $actions];
    }

    /** @return array{0: string, 1: bool, 2: ?array<string, mixed>} */
    private function executeTool(string $projectId, string $toolName, array $input): array
    {
        try {
            return match ($toolName) {
                'create_task' => $this->createTaskTool($projectId, $input),
                'update_task' => $this->updateTaskTool($projectId, $input),
                'get_task_details' => $this->getTaskDetailsTool($projectId, $input),
                'list_critical_tasks' => $this->listCriticalTasksTool($projectId, $input),
                default => ["Unknown tool: {$toolName}", true, null],
            };
        } catch (\Throwable $e) {
            Log::channel()->warning('AI assistant tool failed', ['tool' => $toolName, 'projectId' => $projectId, 'error' => $e->getMessage()]);
            return ['That action failed: ' . $e->getMessage(), true, null];
        }
    }

    private function createTaskTool(string $projectId, array $input): array
    {
        $title = trim((string) ($input['title'] ?? ''));
        if ($title === '') {
            return ['A task title is required.', true, null];
        }

        [$column, $columnError] = $this->resolveColumn($projectId, $input['columnName'] ?? null);
        if ($columnError !== null) {
            return [$columnError, true, null];
        }

        [, $assigneeId, $assigneeError] = $this->resolveAssignee($projectId, $input, 'assigneeName');
        if ($assigneeError !== null) {
            return [$assigneeError, true, null];
        }

        [, $typeId, $typeError] = $this->resolveTaskType($projectId, $input, 'typeName');
        if ($typeError !== null) {
            return [$typeError, true, null];
        }

        $priority = $this->normalizePriority($input['priority'] ?? null) ?? 'medium';
        $dueDate = $this->parseDate($input['dueDate'] ?? null);

        $created = (new TaskService($this->db))->create($projectId, [
            'title' => $title,
            'description' => $input['description'] ?? null,
            'priority' => $priority,
            'columnId' => $column['Id'],
            'assigneeId' => $assigneeId,
            'typeId' => $typeId,
            'endDate' => $dueDate,
        ]);

        if ($created === null) {
            return ['Could not create the task — the target column may no longer exist.', true, null];
        }

        return [
            "Created task {$created['key']}: \"{$created['title']}\" in column \"{$column['Name']}\".",
            false,
            ['type' => 'task_created', 'taskId' => $created['id'], 'taskKey' => $created['key'], 'title' => $created['title']],
        ];
    }

    private function updateTaskTool(string $projectId, array $input): array
    {
        $identifier = trim((string) ($input['taskIdentifier'] ?? ''));
        if ($identifier === '') {
            return ['A task identifier (title or key) is required.', true, null];
        }

        $task = $this->findTask($projectId, $identifier);
        if ($task === null) {
            return ["No task found matching \"{$identifier}\".", true, null];
        }

        $columnId = $task['ColumnId'];
        if (isset($input['columnName'])) {
            [$column, $columnError] = $this->resolveColumn($projectId, $input['columnName']);
            if ($columnError !== null) {
                return [$columnError, true, null];
            }
            $columnId = $column['Id'];
        }

        [$assigneeProvided, $assigneeId, $assigneeError] = $this->resolveAssignee($projectId, $input, 'assigneeName');
        if ($assigneeError !== null) {
            return [$assigneeError, true, null];
        }

        [$typeProvided, $typeId, $typeError] = $this->resolveTaskType($projectId, $input, 'typeName');
        if ($typeError !== null) {
            return [$typeError, true, null];
        }

        $depStmt = $this->db->prepare('SELECT "DependsOnTaskId" FROM "TaskDependencies" WHERE "TaskId" = :id');
        $depStmt->execute(['id' => $task['Id']]);
        $dependsOnTaskIds = $depStmt->fetchAll(PDO::FETCH_COLUMN);

        $updated = (new TaskService($this->db))->update($projectId, $task['Id'], [
            'title' => $input['title'] ?? $task['Title'],
            'description' => $input['description'] ?? $task['Description'],
            'priority' => $this->normalizePriority($input['priority'] ?? null) ?? $task['Priority'],
            'columnId' => $columnId,
            'assigneeId' => $assigneeProvided ? $assigneeId : $task['AssigneeId'],
            'releaseId' => $task['ReleaseId'],
            'typeId' => $typeProvided ? $typeId : $task['TypeId'],
            'parentTaskId' => $task['ParentTaskId'],
            'dependsOnTaskIds' => $dependsOnTaskIds,
            'documentationUrl' => $task['DocumentationUrl'],
            'startDate' => $task['StartDate'],
            'endDate' => $this->parseDate($input['dueDate'] ?? null) ?? $task['EndDate'],
            'businessValue' => $task['BusinessValue'],
            'taskCost' => $task['TaskCost'],
            'progress' => $input['progress'] ?? $task['Progress'],
            'estimatedEffort' => $task['EstimatedEffort'],
            'actualEffort' => $task['ActualEffort'],
            'archived' => $task['Archived'],
        ], 'AI Assistant');

        if ($updated === null) {
            return ['Could not update the task.', true, null];
        }

        return [
            "Updated task {$updated['key']}: \"{$updated['title']}\".",
            false,
            ['type' => 'task_updated', 'taskId' => $updated['id'], 'taskKey' => $updated['key'], 'title' => $updated['title']],
        ];
    }

    private function getTaskDetailsTool(string $projectId, array $input): array
    {
        $identifier = trim((string) ($input['taskIdentifier'] ?? ''));
        if ($identifier === '') {
            return ['A task identifier (title or key) is required.', true, null];
        }

        $task = $this->findTask($projectId, $identifier);
        if ($task === null) {
            return ["No task found matching \"{$identifier}\".", true, null];
        }

        $columnStmt = $this->db->prepare('SELECT "Name" FROM "Columns" WHERE "Id" = :id');
        $columnStmt->execute(['id' => $task['ColumnId']]);
        $columnName = $columnStmt->fetchColumn();

        $assigneeName = 'unassigned';
        if ($task['AssigneeId'] !== null) {
            $stmt = $this->db->prepare('SELECT u."DisplayName" FROM "ProjectMembers" m JOIN "Users" u ON u."Id" = m."UserId" WHERE m."Id" = :id');
            $stmt->execute(['id' => $task['AssigneeId']]);
            $assigneeName = $stmt->fetchColumn() ?: 'unassigned';
        }
        $typeName = 'none';
        if ($task['TypeId'] !== null) {
            $stmt = $this->db->prepare('SELECT "Name" FROM "TaskTypes" WHERE "Id" = :id');
            $stmt->execute(['id' => $task['TypeId']]);
            $typeName = $stmt->fetchColumn() ?: 'none';
        }

        $summary = "{$task['Key']}: \"{$task['Title']}\" — priority {$task['Priority']}, column \"{$columnName}\", " .
            "assignee {$assigneeName}, type {$typeName}, " .
            "progress {$task['Progress']}%, due " . ($task['EndDate'] ?? 'not set') . '.' .
            (($task['Description'] ?? '') !== '' ? " Description: {$task['Description']}" : '');

        return [$summary, false, null];
    }

    private function listCriticalTasksTool(string $projectId, array $input): array
    {
        $limit = max(1, min(20, (int) ($input['limit'] ?? 5)));

        $stmt = $this->db->prepare(<<<SQL
            SELECT t.*, c."Done" AS "ColumnDone" FROM "Tasks" t
            JOIN "Columns" c ON c."Id" = t."ColumnId"
            WHERE t."ProjectId" = :pid AND c."Done" = false AND t."Archived" = false
        SQL);
        $stmt->execute(['pid' => $projectId]);
        $openTasks = $stmt->fetchAll();

        if ($openTasks === []) {
            return ['There are no open tasks in this project.', false, null];
        }

        $ids = array_column($openTasks, 'Id');
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $depStmt = $this->db->prepare(<<<SQL
            SELECT "DependsOnTaskId", COUNT(*) AS cnt FROM "TaskDependencies"
            WHERE "DependsOnTaskId" IN ({$placeholders})
            GROUP BY "DependsOnTaskId"
        SQL);
        $depStmt->execute($ids);
        $dependentCounts = array_column($depStmt->fetchAll(), 'cnt', 'DependsOnTaskId');

        usort($openTasks, function (array $a, array $b) use ($dependentCounts) {
            $pa = array_search($a['Priority'], self::PRIORITY_ORDER, true);
            $pb = array_search($b['Priority'], self::PRIORITY_ORDER, true);
            if ($pa !== $pb) {
                return $pb <=> $pa;
            }
            $da = (int) ($dependentCounts[$a['Id']] ?? 0);
            $db_ = (int) ($dependentCounts[$b['Id']] ?? 0);
            if ($da !== $db_) {
                return $db_ <=> $da;
            }
            return ($a['EndDate'] ?? '9999-12-31') <=> ($b['EndDate'] ?? '9999-12-31');
        });

        $ranked = array_slice($openTasks, 0, $limit);
        $lines = array_map(function (array $t) use ($dependentCounts) {
            $due = $t['EndDate'] ?? 'not set';
            $blocks = (int) ($dependentCounts[$t['Id']] ?? 0);
            return "{$t['Key']} \"{$t['Title']}\" — priority {$t['Priority']}, progress {$t['Progress']}%, due {$due}, blocks {$blocks} other task(s)";
        }, $ranked);

        return [implode("\n", $lines), false, null];
    }

    private function findTask(string $projectId, string $identifier): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Tasks" WHERE "ProjectId" = :pid AND LOWER("Key") = LOWER(:key)');
        $stmt->execute(['pid' => $projectId, 'key' => $identifier]);
        $byKey = $stmt->fetch();
        if ($byKey !== false) {
            return $byKey;
        }

        // MariaDB has no ILIKE — LOWER(...) LIKE LOWER(...) instead (mariadb-api/CLAUDE.md §2's
        // ANSI_QUOTES compatibility doesn't extend to Postgres-only operators like this one).
        $stmt = $this->db->prepare('SELECT * FROM "Tasks" WHERE "ProjectId" = :pid AND LOWER("Title") LIKE LOWER(:title) LIMIT 1');
        $stmt->execute(['pid' => $projectId, 'title' => '%' . $identifier . '%']);
        $byTitle = $stmt->fetch();
        return $byTitle === false ? null : $byTitle;
    }

    /** @return array{0: ?array, 1: ?string} */
    private function resolveColumn(string $projectId, ?string $columnName): array
    {
        $columns = $this->fetchColumns($projectId);
        if ($columns === []) {
            return [null, 'This project has no columns.'];
        }

        if ($columnName === null || trim($columnName) === '') {
            foreach ($columns as $c) {
                if (!$c['Done']) {
                    return [$c, null];
                }
            }
            return [$columns[0], null];
        }

        foreach ($columns as $c) {
            if (strcasecmp($c['Name'], $columnName) === 0) {
                return [$c, null];
            }
        }
        $names = implode(', ', array_column($columns, 'Name'));
        return [null, "No column named \"{$columnName}\". Available columns: {$names}."];
    }

    private function fetchColumns(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM "Columns" WHERE "ProjectId" = :pid ORDER BY "Order" ASC');
        $stmt->execute(['pid' => $projectId]);
        return $stmt->fetchAll();
    }

    private function fetchMembers(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT m."Id", u."DisplayName" FROM "ProjectMembers" m JOIN "Users" u ON u."Id" = m."UserId" WHERE m."ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return $stmt->fetchAll();
    }

    private function fetchTaskTypes(string $projectId): array
    {
        $stmt = $this->db->prepare('SELECT "Id", "Name" FROM "TaskTypes" WHERE "ProjectId" = :pid');
        $stmt->execute(['pid' => $projectId]);
        return $stmt->fetchAll();
    }

    /** Tri-state, mirroring AiAssistantService.cs's ResolveAssigneeAsync: [provided, id, error].
     * Provided=false means the key was absent from the tool input (keep the existing value);
     * provided=true + id=null means an explicit clear ("none"/"unassigned"/empty); error is non-null
     * only when a name was given but didn't match any project member. */
    private function resolveAssignee(string $projectId, array $input, string $key): array
    {
        if (!array_key_exists($key, $input)) {
            return [false, null, null];
        }
        $name = $input[$key];
        if ($name === null || trim((string) $name) === '' || in_array(strtolower((string) $name), ['none', 'unassigned'], true)) {
            return [true, null, null];
        }

        $members = $this->fetchMembers($projectId);
        foreach ($members as $m) {
            if (strcasecmp($m['DisplayName'], (string) $name) === 0) {
                return [true, $m['Id'], null];
            }
        }
        $names = implode(', ', array_column($members, 'DisplayName'));
        return [true, null, "No project member named \"{$name}\". Available: {$names}."];
    }

    /** Same tri-state shape as resolveAssignee(), for TaskType. */
    private function resolveTaskType(string $projectId, array $input, string $key): array
    {
        if (!array_key_exists($key, $input)) {
            return [false, null, null];
        }
        $name = $input[$key];
        if ($name === null || trim((string) $name) === '' || strtolower((string) $name) === 'none') {
            return [true, null, null];
        }

        $types = $this->fetchTaskTypes($projectId);
        foreach ($types as $t) {
            if (strcasecmp($t['Name'], (string) $name) === 0) {
                return [true, $t['Id'], null];
            }
        }
        $names = $types === [] ? '(none defined for this project)' : implode(', ', array_column($types, 'Name'));
        return [true, null, "No task type named \"{$name}\". Available: {$names}."];
    }

    private function normalizePriority(?string $priority): ?string
    {
        if ($priority === null) {
            return null;
        }
        $lower = strtolower($priority);
        return in_array($lower, self::PRIORITY_ORDER, true) ? $lower : 'medium';
    }

    private function parseDate(?string $date): ?string
    {
        if ($date === null || $date === '') {
            return null;
        }
        $parsed = \DateTime::createFromFormat('Y-m-d', $date);
        return $parsed !== false ? $date : null;
    }

    private function buildSystemPrompt(string $projectName, array $columns, array $members, array $taskTypes, ?string $alertsSummary): string
    {
        $columnList = implode(', ', array_map(
            static fn(array $c) => '"' . $c['Name'] . '"' . ($c['Done'] ? ' (done)' : ''),
            $columns
        ));
        $memberList = $members === [] ? '(none)' : implode(', ', array_map(
            static fn(array $m) => '"' . $m['DisplayName'] . '"',
            $members
        ));
        $typeList = $taskTypes === [] ? '(none defined)' : implode(', ', array_map(
            static fn(array $t) => '"' . $t['Name'] . '"',
            $taskTypes
        ));

        $prompt = "You are the AI assistant embedded in the Enkl project management app, working within the project \"{$projectName}\".\n" .
            "Its board columns, in order, are: {$columnList}.\n" .
            "Its project members (valid assignee names) are: {$memberList}.\n" .
            "Its task types (valid type names) are: {$typeList}.\n" .
            "Use the provided tools to create tasks, edit tasks, look up task details, and list the most critical open tasks. " .
            "When a request is ambiguous (e.g. which task, which column, which member), ask a brief clarifying question rather than guessing destructively.\n" .
            "Keep replies short and conversational — this is a chat-style assistant, not a report generator.\n";

        if ($alertsSummary !== null && trim($alertsSummary) !== '') {
            $prompt .= "Current alerts for this project (computed client-side, already up to date): {$alertsSummary}\n";
        }

        return $prompt;
    }

    private function toolDefinitions(): array
    {
        return [
            [
                'name' => 'create_task',
                'description' => 'Create a new task on the board. Call this whenever the user asks to create/add a task.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'title' => ['type' => 'string', 'description' => 'The task title.'],
                        'description' => ['type' => 'string'],
                        'priority' => ['type' => 'string', 'enum' => self::PRIORITY_ORDER],
                        'columnName' => ['type' => 'string', 'description' => 'Which board column to place it in. Omit to use the first non-done column.'],
                        'assigneeName' => ['type' => 'string', 'description' => 'Display name of the project member to assign this task to. Must match one of the project\'s members.'],
                        'typeName' => ['type' => 'string', 'description' => 'Name of the task type. Must match one of the project\'s defined task types.'],
                        'dueDate' => ['type' => 'string', 'description' => 'ISO date (YYYY-MM-DD), optional.'],
                    ],
                    'required' => ['title'],
                ],
            ],
            [
                'name' => 'update_task',
                'description' => 'Edit an existing task — change its title, description, priority, column, due date, or progress. Only the fields you provide are changed.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'taskIdentifier' => ['type' => 'string', 'description' => "The task's key (e.g. PROJ-12) or title/part of its title."],
                        'title' => ['type' => 'string'],
                        'description' => ['type' => 'string'],
                        'priority' => ['type' => 'string', 'enum' => self::PRIORITY_ORDER],
                        'columnName' => ['type' => 'string'],
                        'assigneeName' => ['type' => 'string', 'description' => 'Display name of the project member to assign. Pass "none"/"unassigned" to clear the assignee.'],
                        'typeName' => ['type' => 'string', 'description' => 'Name of the task type. Pass "none" to clear it.'],
                        'dueDate' => ['type' => 'string', 'description' => 'ISO date (YYYY-MM-DD).'],
                        'progress' => ['type' => 'integer', 'description' => '0-100.'],
                    ],
                    'required' => ['taskIdentifier'],
                ],
            ],
            [
                'name' => 'get_task_details',
                'description' => "Look up a single task's current details by key or title.",
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['taskIdentifier' => ['type' => 'string']],
                    'required' => ['taskIdentifier'],
                ],
            ],
            [
                'name' => 'list_critical_tasks',
                'description' => "List the most critical open tasks in this project, ranked by priority, how many other tasks depend on them, and due date. Use this to answer questions like 'what should I work on next' or 'what's most critical'.",
                'input_schema' => [
                    'type' => 'object',
                    'properties' => ['limit' => ['type' => 'integer', 'description' => 'How many tasks to return, default 5.']],
                ],
            ],
        ];
    }

    private function callAnthropic(string $apiKey, array $body): array
    {
        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'x-api-key: ' . $apiKey,
                'anthropic-version: 2023-06-01',
            ],
            CURLOPT_TIMEOUT => 60,
        ]);
        $responseBody = curl_exec($ch);
        $statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($responseBody === false || $curlError !== '') {
            Log::channel()->error('Anthropic API request failed', ['error' => $curlError]);
            throw new \RuntimeException('The AI assistant is temporarily unavailable. Please try again.');
        }

        $decoded = json_decode((string) $responseBody, true);
        if ($statusCode < 200 || $statusCode >= 300 || !is_array($decoded)) {
            Log::channel()->error('Anthropic API returned an error', ['statusCode' => $statusCode, 'body' => $responseBody]);
            throw new \RuntimeException('The AI assistant is temporarily unavailable. Please try again.');
        }

        return $decoded;
    }
}
