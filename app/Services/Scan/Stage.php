<?php

declare(strict_types=1);

namespace App\Services\Scan;

use App\Enums\ScanStage;

/**
 * One step of the scanning pipeline. Stages communicate exclusively through
 * artefacts on disk, which makes the whole scan resumable and inspectable.
 */
interface Stage
{
    public function name(): ScanStage;

    /**
     * @return array{summary:?string, metrics?:array<string,mixed>}
     */
    public function run(ScanContext $context): array;
}
