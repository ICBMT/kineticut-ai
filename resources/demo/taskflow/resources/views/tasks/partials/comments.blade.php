<div class="mt-3 space-y-3">
    @foreach ($comments as $comment)
        <div class="rounded-lg border border-slate-200 bg-white p-4">
            <p class="text-sm font-medium">{{ $comment->author->name }}</p>
            <p class="mt-1 text-sm text-slate-600">{{ $comment->body }}</p>
        </div>
    @endforeach
</div>
