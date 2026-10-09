<?php

declare(strict_types=1);

namespace App\Services\Scan\Languages;

use App\Enums\Language;
use App\Enums\ScanStage;

/**
 * Python — Django, Flask, FastAPI and plain scripts.
 *
 * Python is several projects in a trench coat, so detection asks the questions
 * that separate them: a `manage.py` is Django, a `pyproject.toml` is a packaged
 * application or library, a pile of `.py` files with none of those is still a
 * Python project, and any of them beats "no idea". The framework itself is
 * worked out later by the build stage, from the dependencies — the profile only
 * has to be sure enough to claim the directory.
 *
 * The plan keeps the Laravel pipeline's vocabulary because Python genuinely has
 * that shape: routes exist (Django `urlpatterns`, Flask and FastAPI
 * decorators), models exist (Django ORM, SQLAlchemy), and templates exist
 * (Django's `{% extends %}`). Anything a project does not have simply produces
 * no nodes.
 */
class PythonProfile extends LanguageProfile
{
    /** Environments and caches — nobody's architecture lives here. */
    private const SKIP_DIRS = [
        '__pycache__', '.venv', 'venv', 'env', 'virtualenv', 'site-packages',
        '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs',
        '.ipynb_checkpoints', 'htmlcov', '.git', 'node_modules', 'build', 'dist',
        '.idea', '.vscode', '.vs', '.cache',
        // Vendored trees, named the way Python projects name them.
        'third_party', 'third-party', 'vendor', 'vendors', 'site_packages',
        '.eggs', 'wheels',
    ];

    public function language(): Language
    {
        return Language::Python;
    }

    public function detect(string $root): int
    {
        $score = 0;

        // A Django project announces itself with manage.py, and nothing else in
        // this list is as specific.
        if ($this->has($root, 'manage.py')) {
            $score += 34;
        }

        if ($this->has($root, 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock')) {
            $score += 30;
        }

        if ($this->has($root, 'requirements.txt', 'setup.py', 'setup.cfg', 'tox.ini', 'conftest.py', 'pytest.ini')) {
            $score += 22;
        }

        foreach (['app', 'apps', 'src', 'tests', 'templates'] as $directory) {
            if (is_dir($root.'/'.$directory)) {
                $score += 3;
            }
        }

        /*
         * Source files are the evidence that survives every missing manifest —
         * a script folder has no pyproject.toml, no manage.py and no
         * requirements.txt, and it is still a Python project. A pile of scripts
         * is how a lot of people meet Python in the first place, so .py files
         * are counted strongly enough to clear the registry's 20-point floor on
         * their own: two of them win, one is a stray file in a docs folder.
         */
        $sources = $this->countFiles($root, ['.py', '.pyi'], 20);

        $score += min(45, $sources * 10);

        return min(100, $score);
    }

    /**
     * The same order as `ScanStage::planFor('python')`.
     *
     * The file tree comes first because Python has no build system to read the
     * project out of: the manifests name the project, but the modules and the
     * entry scripts are found by walking it.
     */
    public function plan(): array
    {
        return [
            ScanStage::Files,
            ScanStage::Build,
            ScanStage::Declarations,
            ScanStage::References,
            ScanStage::Calls,
            ScanStage::Routes,
            ScanStage::Models,
            ScanStage::Views,
            ScanStage::Insights,
            ScanStage::Layout,
        ];
    }

    public function moduleFor(string $relativePath): string
    {
        $path = $this->stripContainers($relativePath, [
            'src', 'source', 'lib', 'libs', 'code', 'tests', 'test', 'scripts', 'examples',
        ]);

        $segments = explode('/', $path);

        // A file at the root (manage.py, main.py) is the project itself; the
        // first real folder is the package or Django app it belongs to.
        return count($segments) > 1 ? $segments[0] : 'Project';
    }

    public function skipDirectories(): array
    {
        return self::SKIP_DIRS;
    }

    public function extraSourceExtensions(): array
    {
        return ['py', 'pyi', 'pyw', 'html', 'jinja', 'jinja2', 'j2', 'toml', 'cfg', 'ini'];
    }

    public function fileLanguage(string $path): ?string
    {
        $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));

        return match ($extension) {
            'py', 'pyi', 'pyw' => 'python',
            'html', 'jinja', 'jinja2', 'j2' => 'template',
            'toml' => 'toml',
            default => null,
        };
    }
}
