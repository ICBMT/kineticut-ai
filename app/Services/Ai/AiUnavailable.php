<?php

declare(strict_types=1);

namespace App\Services\Ai;

use RuntimeException;

/**
 * The model could not answer — not running, wrong port, too slow.
 *
 * The message is shown to the person who asked, so it says what to do next
 * rather than naming a syscall.
 */
class AiUnavailable extends RuntimeException
{
}
