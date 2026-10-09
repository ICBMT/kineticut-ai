<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreProjectRequest;
use App\Models\Project;
use App\Services\ProjectService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class ProjectController extends Controller
{
    public function __construct(private readonly ProjectService $projects)
    {
        $this->middleware('auth');
    }

    public function index(Request $request): View
    {
        $projects = $this->projects->forUser($request->user());

        return view('projects.index', ['projects' => $projects]);
    }

    public function store(StoreProjectRequest $request): RedirectResponse
    {
        $project = $this->projects->create($request->user(), $request->validated());

        return redirect()->route('projects.index')->with('status', "{$project->name} created.");
    }

    public function show(Project $project): View
    {
        $this->authorize('view', $project);

        return view('projects.show', ['project' => $project->load('tasks', 'owner', 'members')]);
    }

    public function destroy(Project $project): RedirectResponse
    {
        $this->authorize('delete', $project);

        $this->projects->archive($project);

        return redirect()->route('projects.index')->with('status', 'Project archived.');
    }
}
