<?php

declare(strict_types=1);

namespace Enkl\Api\Validation;

/**
 * Ported from Validation/CycleDetection.cs, itself ported from wouldCreateCycle/wouldCreateParentCycle
 * (src/js/utils.js). Operates over a whole adjacency/parent map at once (not "would adding this one
 * edge create a cycle") since MigrationService has to validate an entire freshly-imported, untrusted
 * graph/tree in one pass.
 */
final class CycleDetection
{
    /**
     * General directed-graph cycle check — used for the Task dependency DAG.
     * @param array<string, string[]> $adjacency taskId => [dependsOnTaskId, ...]
     */
    public static function hasCycle(array $adjacency): bool
    {
        $visiting = [];
        $visited = [];

        $dfs = function (string $node) use (&$dfs, &$visiting, &$visited, $adjacency): bool {
            if (isset($visiting[$node])) {
                return true;
            }
            if (isset($visited[$node])) {
                return false;
            }
            $visiting[$node] = true;
            foreach ($adjacency[$node] ?? [] as $dep) {
                if ($dfs($dep)) {
                    return true;
                }
            }
            unset($visiting[$node]);
            $visited[$node] = true;
            return false;
        };

        foreach (array_keys($adjacency) as $node) {
            if ($dfs($node)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Single-parent tree check — used for both the Sub-Tasks tree (Task.ParentTaskId) and the
     * TeamCommittee tree (TeamCommittee.ParentId). A cycle exists if walking any node's parent chain
     * revisits a node before reaching a null parent.
     * @param array<string, ?string> $parentById nodeId => parentId (or null)
     */
    public static function hasParentCycle(array $parentById): bool
    {
        foreach (array_keys($parentById) as $start) {
            $seen = [];
            $current = $start;
            while ($current !== null) {
                if (isset($seen[$current])) {
                    return true;
                }
                $seen[$current] = true;
                $current = $parentById[$current] ?? null;
            }
        }
        return false;
    }
}
