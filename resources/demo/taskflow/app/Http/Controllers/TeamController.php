<?php

namespace App\Http\Controllers;

use App\Models\Team;
use App\Notifications\TeamInvitationNotification;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

class TeamController extends Controller
{
    public function index(Request $request): View
    {
        return view('teams.index', ['teams' => $request->user()->teams]);
    }

    public function store(Request $request): RedirectResponse
    {
        $team = Team::create($request->validate([
            'name' => ['required', 'string', 'max:60'],
        ]) + ['slug' => str()->slug($request->input('name')), 'plan' => 'trial']);

        $team->members()->attach($request->user()->id, ['role' => 'owner']);

        return redirect()->route('teams.index');
    }

    public function destroy(Team $team): RedirectResponse
    {
        $team->invitations->each(fn ($invitation) => $invitation->delete());
        $team->delete();

        return redirect()->route('teams.index');
    }
}
