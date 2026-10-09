<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\File;

abstract class TestCase extends BaseTestCase
{
    /**
     * Workspace directories that existed before this test ran.
     *
     * @var array<int, string>
     */
    private array $existingWorkspaces = [];

    /** @var array<int, string> */
    private array $existingUploads = [];

    /**
     * The scanner unpacks every fixture into `storage/app/atlas/{uuid}` and the
     * database rollback cannot delete files. Without this the suite left a
     * project workspace behind after every single test — 87 of them, ~900 files,
     * which is what quietly pushed the repository past its file budget.
     */
    protected function setUp(): void
    {
        parent::setUp();

        $this->existingWorkspaces = $this->entries(storage_path('app/atlas'));
        $this->existingUploads = $this->entries(storage_path('app/atlas/_uploads'));
    }

    protected function tearDown(): void
    {
        foreach (array_diff($this->entries(storage_path('app/atlas/_uploads')), $this->existingUploads) as $token) {
            File::deleteDirectory(storage_path('app/atlas/_uploads/'.$token));
        }

        foreach (array_diff($this->entries(storage_path('app/atlas')), $this->existingWorkspaces) as $uuid) {
            if ($uuid === '_uploads') {
                continue;
            }

            File::deleteDirectory(storage_path('app/atlas/'.$uuid));
        }

        parent::tearDown();
    }

    /**
     * Directory entries in a path, ignoring the dot entries.
     *
     * @return array<int, string>
     */
    private function entries(string $path): array
    {
        if (! is_dir($path)) {
            return [];
        }

        return array_values(array_diff(scandir($path) ?: [], ['.', '..']));
    }
}
