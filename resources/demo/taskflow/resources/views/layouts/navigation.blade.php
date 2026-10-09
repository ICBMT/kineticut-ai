<nav class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="{{ route('dashboard') }}" class="font-semibold">{{ config('app.name') }}</a>

        <div class="flex items-center gap-4 text-sm">
            <a href="{{ route('projects.index') }}">Projects</a>
            <a href="{{ route('tasks.index') }}">Tasks</a>
            @if (auth()->user()?->isAdmin())
                <a href="{{ route('teams.index') }}">Teams</a>
            @endif
            <x-badge :color="auth()->user()?->isAdmin() ? 'violet' : 'slate'">
                {{ auth()->user()->name }}
            </x-badge>
        </div>
    </div>
</nav>
